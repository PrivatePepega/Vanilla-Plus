// api/auth-ping/route.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';

const secretsManager = new SecretsManagerClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function getSecrets() {
  try {
    const command = new GetSecretValueCommand({ SecretId: process.env.AWS_SECRET_ID });
    const data = await secretsManager.send(command);
    if ('SecretString' in data) return JSON.parse(data.SecretString);
    throw new Error('Secrets not found');
  } catch (err) {
    console.error('SecretsManager error:', err.message);
    throw err;
  }
}

function formatPemKey(key) {
  try {
    let trimmedKey = key.trim();
    const beginHeader = '-----BEGIN PRIVATE KEY-----';
    const endHeader = '-----END PRIVATE KEY-----';
    const beginIndex = trimmedKey.indexOf(beginHeader);
    const endIndex = trimmedKey.indexOf(endHeader);
    if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
      throw new Error('Invalid PEM key headers');
    }
    let base64Content = trimmedKey.slice(beginIndex + beginHeader.length, endIndex).trim();
    base64Content = base64Content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(base64Content)) {
      throw new Error('Invalid base64 content');
    }
    const lines = [];
    for (let i = 0; i < base64Content.length; i += 64) {
      lines.push(base64Content.slice(i, i + 64));
    }
    return `${beginHeader}\n${lines.join('\n')}\n${endHeader}\n`;
  } catch (err) {
    console.error('Failed to format PEM key:', err.message);
    throw err;
  }
}

export async function POST(request) {
  try {
    const { wallet, signedMessage, game, type, cache, accountName } = await request.json();

    if (!wallet || !signedMessage || !game || !type || !cache || !accountName) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const { SUPABASE_URL, SUPABASE_KEY, APP_SECRET, RSA_PRIVATE } = await getSecrets();

    if (!SUPABASE_URL || !SUPABASE_KEY || !APP_SECRET || !RSA_PRIVATE) {
      console.error('Missing required secrets');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Validate and format private key
    let formattedPrivateKey;
    try {
      formattedPrivateKey = formatPemKey(RSA_PRIVATE);
    } catch (err) {
      return NextResponse.json({ error: `Failed to format private key: ${err.message}` }, { status: 500 });
    }

    // Decrypt signedMessage
    let decrypted;
    try {
      decrypted = crypto.privateDecrypt(
        { key: formattedPrivateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
        Buffer.from(signedMessage, 'base64')
      ).toString('utf8');
      decrypted = decrypted.split(':');
    } catch (err) {
      console.error('RSA decryption error:', err.message);
      return NextResponse.json({ error: `Invalid signed message: ${err.message}` }, { status: 400 });
    }

    const [fileHash, gameName, secret, signedType, timeField, account] = decrypted;

    // Validate inputs
    if (secret !== APP_SECRET) return NextResponse.json({ error: 'Invalid app secret' }, { status: 401 });
    if (game !== gameName || type !== signedType || accountName !== account) {
      return NextResponse.json({ error: 'Mismatched game, type, or account' }, { status: 400 });
    }
    if (!['daily', 'weekly'].includes(type)) {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    // Upsert user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('wallet')
      .eq('wallet', wallet)
      .single();
    if (userError && userError.code !== 'PGRST116') {
      console.error('Supabase user query error:', userError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (!user) {
      const { error: insertError } = await supabase.from('users').insert({ wallet });
      if (insertError) {
        console.error('Supabase user insert error:', insertError);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
    }

    // Upsert account
    const { data: accountData, error: accountError } = await supabase
      .from('accounts')
      .select('wallet')
      .eq('account_name', accountName)
      .single();
    if (accountError && accountError.code !== 'PGRST116') {
      console.error('Supabase account query error:', accountError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (accountData) {
      if (accountData.wallet !== wallet) {
        return NextResponse.json({ error: 'Account tied to another wallet' }, { status: 400 });
      }
    } else {
      const { error: insertError } = await supabase
        .from('accounts')
        .insert({ account_name: accountName, wallet, game_name: game });
      if (insertError) {
        console.error('Supabase account insert error:', insertError);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
    }

    // Check for existing completion
    const timeFieldValue = type === 'daily' ? { date: cache.date }  
    : { week: cache.week };
    const { data: existingHash, error: hashError } = await supabase
      .from('file_hashes')
      .select('id')
      .eq('account_name', accountName)
      .eq('type', type)
      .eq(type === 'daily' ? 'date' : 'week', timeFieldValue[type === 'daily' ? 'date' : 'week'])
      .single();
    if (hashError && hashError.code !== 'PGRST116') {
      console.error('Supabase hash query error:', hashError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (existingHash) {
      return NextResponse.json(
        { error: `${type.charAt(0).toUpperCase() + type.slice(1)} already completed for this period` },
        { status: 409 }
      );
    }

    // Verify fileHash
    const computedFileHash = crypto.createHash('sha256').update(JSON.stringify(cache)).digest('hex');
    if (computedFileHash !== fileHash) {
      return NextResponse.json({ error: 'File hash mismatch' }, { status: 400 });
    }

    // Insert new file_hash
    const { error: insertError } = await supabase.from('file_hashes').insert({
      account_name: accountName,
      file_hash: fileHash,
      type,
      date: type === 'daily' ? cache.date : null,
      week: type === 'weekly' ? cache.week : null,
      minted: false,
    });

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return NextResponse.json({ error: `Failed to log ${type}: ${insertError.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('Auth ping error:', err.message);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}