import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';
import { readContract } from 'thirdweb';
import { contractPassport } from "@/utils/functionDump/getContracts";
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

function getCurrentWeek() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  // handles "2026-07-5" and "2026-07-05" → always "2026-07-05"
  const [year, month, day] = dateStr.split('-');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function normalizeWeek(weekStr) {
  if (!weekStr) return null;
  // handles "2026-W3" and "2026-W03" → always "2026-W03"
  const [year, week] = weekStr.split('-W');
  return `${year}-W${week.padStart(2, '0')}`;
}



function formatPemKey(key) {
  try {
    let trimmedKey = key.trim();
    const beginHeader = '-----BEGIN PRIVATE KEY-----';
    const endHeader = '-----END PRIVATE KEY-----';
    const beginIndex = trimmedKey.indexOf(beginHeader);
    const endIndex = trimmedKey.indexOf(endHeader);
    if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
      throw new Error('PEM headers missing or malformed');
    }
    let base64Content = trimmedKey.slice(beginIndex + beginHeader.length, endIndex).trim();
    base64Content = base64Content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(base64Content)) {
      throw new Error('Base64 content is invalid');
    }
    const lines = [];
    for (let i = 0; i < base64Content.length; i += 64) {
      lines.push(base64Content.slice(i, i + 64));
    }
    return `${beginHeader}\n${lines.join('\n')}\n${endHeader}\n`;
  } catch (err) {
    console.error('Failed to format PEM key:', { error: err.message });
    throw err;
  }
}


const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const authPingLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
});


export async function POST(request) {

  const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1';
  const { success } = await authPingLimiter.limit(ip);
  if (!success) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }


  async function getSecrets() {
    const secretsManager = new SecretsManagerClient({
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.GB_ACCESS_KEY_ID,
        secretAccessKey: process.env.GB_SECRET_ACCESS_KEY,
      },
    });
    const command = new GetSecretValueCommand({ SecretId: process.env.GB_SECRET_ID });
    const data = await secretsManager.send(command);
    if ('SecretString' in data) return JSON.parse(data.SecretString);
    throw new Error('Secrets not found');
  }


  try {
    const { wallet, publicKey, signedMessage, game, type, cache } = await request.json();

    if (!wallet || !publicKey || !signedMessage || !game || !type || !cache) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const { SUPABASE_URL, SUPABASE_KEY, APP_SECRET, RSA_PRIVATE } = await getSecrets();

    if (!SUPABASE_URL || !SUPABASE_KEY || !APP_SECRET || !RSA_PRIVATE) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // --- DOOR 1: phone verified check ---
    const { data: walletRow, error: walletError } = await supabase
      .from('wallets')
      .select('phone_verified')
      .eq('wallet', wallet)
      .single();

    if (walletError || !walletRow) {
      return NextResponse.json({ error: 'Wallet not registered' }, { status: 401 });
    }
    if (!walletRow.phone_verified) {
      return NextResponse.json({ error: 'Phone not verified' }, { status: 401 });
    }
    console.log('Phone verified check passed');

    // --- Decrypt payload ---
    if (!RSA_PRIVATE.includes('-----BEGIN PRIVATE KEY-----')) {
      return NextResponse.json({ error: 'Server key configuration error' }, { status: 500 });
    }

    let formattedPrivateKey;
    try {
      formattedPrivateKey = formatPemKey(RSA_PRIVATE);
    } catch (err) {
      return NextResponse.json({ error: `Failed to format private key: ${err.message}` }, { status: 400 });
    }

    let decrypted;
    try {
      const { key, iv, tag, data } = JSON.parse(signedMessage);
      const aesKey = crypto.privateDecrypt(
        { key: formattedPrivateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
        Buffer.from(key, 'base64')
      );
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      let plaintext = decipher.update(Buffer.from(data, 'base64'), undefined, 'utf8');
      plaintext += decipher.final('utf8');
      decrypted = plaintext.split(':');
    } catch (err) {
      console.error('Hybrid decryption error:', { error: err.message });
      return NextResponse.json({ error: `Invalid signed message: ${err.message}` }, { status: 400 });
    }

    const [fileHash, gameName, userPassword, signedType, timeField, accountName, timestamp, nonce, signature] = decrypted;

    // --- HMAC signature check ---
    const payloadFields = `${fileHash}:${gameName}:${userPassword}:${signedType}:${timeField}:${accountName}:${timestamp}:${nonce}`;
    const expectedSignature = crypto.createHmac('sha256', APP_SECRET).update(payloadFields).digest('hex');
    const sigBuf = Buffer.from(signature || '', 'hex');
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const validSignature = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);

    if (!validSignature) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // --- Timestamp check ---
    const tsNum = parseInt(timestamp, 10);
    if (!tsNum || Math.abs(Date.now() - tsNum) > 2 * 60 * 1000) {
      return NextResponse.json({ error: 'Request expired' }, { status: 401 });
    }
    console.log('Signature + timestamp valid');

    // --- Date/week check ---
    if (type === 'daily') {
      const today = new Date().toISOString().split('T')[0];
      if (cache.date !== today) {
        return NextResponse.json({ error: 'Invalid date: must be today' }, { status: 400 });
      }
    }
    if (type === 'daily') {
      const today = new Date().toISOString().split('T')[0]; // always "2026-07-05"
      const normalizedCacheDate = normalizeDate(cache.date);
      if (normalizedCacheDate !== today) {
        return NextResponse.json({ error: 'Invalid date: must be today' }, { status: 400 });
      }
      cache.date = normalizedCacheDate; // normalize before storing
    }

    // --- Game + type validation ---
    if (game !== gameName || type !== signedType) {
      return NextResponse.json({ error: 'Mismatched game or type' }, { status: 400 });
    }
    if (game !== 'vanilla-plus') {
      return NextResponse.json({ error: 'Invalid game' }, { status: 400 });
    }
    if (!['daily', 'weekly'].includes(type)) {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    // --- DOOR 2: blockchain password check ---
    try {
      const blockchainPasswordHash = await readContract({
        contract: contractPassport,
        method: "function viewUserPassword(address _user) view returns (string memory)",
        params: [wallet]
      });
      if (blockchainPasswordHash !== userPassword) {
        console.log('Blockchain auth failed');
        return NextResponse.json({ error: 'Blockchain auth failed' }, { status: 401 });
      }
    } catch (err) {
      console.error('Thirdweb blockchain error:', { error: err.message });
      return NextResponse.json({ error: 'Blockchain verification failed' }, { status: 500 });
    }
    console.log('Blockchain password ready');

    // --- Duplicate check ---
    const timeFieldValue = type === 'daily' ? cache.date : cache.week;
    const { data: existingHash, error: hashError } = await supabase
      .from('file_hashes')
      .select('id')
      .eq('account_name', accountName)
      .eq('game_name', game)
      .eq('type', type)
      .eq(type === 'daily' ? 'date' : 'week', timeFieldValue)
      .single();

    if (hashError && hashError.code !== 'PGRST116') {
      console.error('Supabase hash query error:', hashError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (existingHash) {
      return NextResponse.json({ error: `${type.charAt(0).toUpperCase() + type.slice(1)} log already exists` }, { status: 409 });
    }

    // --- File hash integrity check ---
    const computedFileHash = crypto.createHash('sha256').update(JSON.stringify(cache)).digest('hex');
    if (computedFileHash !== fileHash) {
      return NextResponse.json({ error: 'File hash mismatch' }, { status: 400 });
    }

    // --- Insert file hash ---
    const { error: insertError } = await supabase
      .from('file_hashes')
      .insert({
        account_name: accountName,
        game_name: game,
        file_hash: fileHash,
        type,
        date: type === 'daily' ? cache.date : null,
        week: type === 'weekly' ? cache.week : null,
        minted: false,
        wallet,
      });

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return NextResponse.json({ error: `Failed to log ${type}: ${insertError.message}` }, { status: 500 });
    }

    console.log('Payload successfully received');
    return NextResponse.json({ success: true }, { status: 200 });

  } catch (err) {
    console.error('Auth ping error:', { error: err.message });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}