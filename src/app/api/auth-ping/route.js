import { createClient } from '@supabase/supabase-js';
import { chainById } from '@/utils/thirdweb/chains';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';
import {contractAddresses} from "@/utils/contractAddressHardhat"
import { readContract } from 'thirdweb'; 
import { contractPassport } from "@/utils/functionDump/getContracts"





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
    console.error('SecretsManager error:', { error: err.message });
    throw err;
  }
}

// Validate environment variables
if (!process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID) {
  console.error('Missing NEXT_PUBLIC_THIRDWEB_CLIENT_ID in environment variables');
  throw new Error('Thirdweb configuration error');
}
if (!chainById) {
  console.error('Invalid chainById configuration');
  throw new Error('Thirdweb chain configuration error');
}




function checkRSAKeyPair(publicKey, privateKey) {
  try {
    // Validate PEM format
    if (!publicKey.includes('-----BEGIN PUBLIC KEY-----') || !publicKey.includes('-----END PUBLIC KEY-----')) {
      throw new Error('Invalid public key: Missing PEM headers');
    }
    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----') || !privateKey.includes('-----END PRIVATE KEY-----')) {
      throw new Error('Invalid private key: Missing PEM headers');
    }

    // Test message
    const testMessage = 'RSA_KEY_PAIR_TEST';
    const testBuffer = Buffer.from(testMessage);

    // Encrypt with public key
    const encrypted = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
      testBuffer
    );

    // Decrypt with private key
    const decrypted = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
      encrypted
    ).toString('utf8');

    // Check if decrypted matches original
    if (decrypted !== testMessage) {
      throw new Error('Key pair mismatch: Decrypted message does not match original');
    }

    console.log('RSA key pair is valid and matches');
    return true;
  } catch (err) {
    console.error('RSA key pair check failed:', { error: err.message });
    return false;
  }
}


function formatPemKey(key) {
  try {
    // Trim any extra crap
    let trimmedKey = key.trim();

    // Define the headers
    const beginHeader = '-----BEGIN PRIVATE KEY-----';
    const endHeader = '-----END PRIVATE KEY-----';

    // Find where the headers are
    const beginIndex = trimmedKey.indexOf(beginHeader);
    const endIndex = trimmedKey.indexOf(endHeader);

    // If headers are missing or fucked up, bail
    if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
      throw new Error('Headers are there but something’s messed up, bro');
    }

    // Pull out the base64 meat between the headers
    let base64Content = trimmedKey.slice(beginIndex + beginHeader.length, endIndex).trim();

    // Nuke all whitespace from the base64
    base64Content = base64Content.replace(/\s+/g, '');

    // Make sure it’s legit base64
    if (!/^[A-Za-z0-9+/=]+$/.test(base64Content)) {
      throw new Error('Base64 content is jacked up');
    }

    // Chop it into 64-char lines
    const lines = [];
    for (let i = 0; i < base64Content.length; i += 64) {
      lines.push(base64Content.slice(i, i + 64));
    }

    // Slap it back together with newlines
    const formattedKey = `${beginHeader}\n${lines.join('\n')}\n${endHeader}\n`;

    // Log it so we can see what’s up
    // console.log('Formatted key preview:\n', formattedKey.slice(0, 100) + '...');
    return formattedKey;
  } catch (err) {
    console.error('Failed to format PEM key, dude:', { error: err.message });
    throw err;
  }
}











export async function POST(request) {





  try {
    const { wallet, publicKey, signedMessage, game, type, cache } = await request.json();

    if (!wallet || !publicKey || !signedMessage || !game || !type || !cache) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const { SUPABASE_URL, SUPABASE_KEY, APP_SECRET, SERVER_WALLET_PASSWORD, RSA_PUBLIC, RSA_PRIVATE } = await getSecrets();

// console.log("RSA_PRIVATE", RSA_PRIVATE);
// console.log("server RSA", serverPrivateKey);

    // Validate secrets
    if (!SUPABASE_URL || !SUPABASE_KEY || !APP_SECRET || !RSA_PRIVATE) {
      console.error('Missing required secrets');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Validate RSA_PRIVATE
    if (!RSA_PRIVATE.includes('-----BEGIN PRIVATE KEY-----')) {
      console.error('Invalid RSA_PRIVATE: Missing PEM format');
      return NextResponse.json({ error: 'Server key configuration error' }, { status: 500 });
    }

        // Reformat the private key to PEM with newlines
        let formattedPrivateKey;
        try {
          // console.log("RSA_PRIVATE:", RSA_PRIVATE);
          // console.log("serverPrivateKey:", serverPrivateKey);

          formattedPrivateKey = formatPemKey(RSA_PRIVATE);
          // checkRSAKeyPair(serverPublicKey, formattedPrivateKey);

          // console.log("formattedPrivateKey", formattedPrivateKey);
        } catch (err) {
          return NextResponse.json({ error: `Failed to format private key: ${err.message}. rsa key: ${RSA_PRIVATE}` }, { status: 400 });
        }

    // Decrypt signedMessage with RSA private key
    let decrypted;
    try {
      decrypted = crypto.privateDecrypt(
        { key: formattedPrivateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
        Buffer.from(signedMessage, 'base64')
      ).toString('utf8');
      decrypted = decrypted.split(':');
    } catch (err) {
      console.error('RSA decryption error:', { error: err.message });
      return NextResponse.json({ error: `Invalid signed message: ${err.message}` }, { status: 400 });
    }

    const [fileHash, gameName, secret, userPassword, signedType, timeField] = decrypted;

    // Validate inputs
    if (secret !== APP_SECRET) return NextResponse.json({ error: 'Invalid app secret' }, { status: 401 });
    if (game !== gameName || type !== signedType) return NextResponse.json({ error: 'Mismatched game or type' }, { status: 400 });
    if (game !== 'vanilla-plus') return NextResponse.json({ error: 'Invalid game' }, { status: 400 });
    if (!['daily', 'weekly'].includes(type)) return NextResponse.json({ error: 'Invalid type' }, { status: 400 });

    // Verify blockchain password
    try {
      console.log("wallet", wallet);
      console.log("wallet.wallet", wallet.wallet);

      console.log("userPassword", userPassword);
      console.log("contractAddresses.Passport", contractAddresses.Passport);

      const blockchainPasswordHash = await readContract({
        contract: contractPassport,
        method: "function viewUserPassword(address _user) view returns (string memory)",
        params: [wallet.wallet]
      });
      console.log("blockchainPasswordHash", blockchainPasswordHash);
      console.log("userPassword", userPassword);

      // const userPasswordHash = crypto.createHash('sha256').update(userPassword).digest('hex');
      if (blockchainPasswordHash !== userPassword) {
        return NextResponse.json({ error: 'Blockchain auth failed' }, { status: 401 });
      }
    } catch (err) {
      console.error('Thirdweb blockchain error:', { error: err.message });
      return NextResponse.json({ error: 'Blockchain verification failed' }, { status: 500 });
    }

    // Upsert user
    const { data: user, error: userError } = await supabase.from('users').select('wallet').eq('wallet', wallet.wallet).single();
    if (userError && userError.code !== 'PGRST116') {
      console.error('Supabase user query error:', userError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (!user) {
      const { error: insertError } = await supabase.from('users').insert({
        wallet: wallet.wallet,
        password_hash: userPassword,
        public_key: publicKey,
      });
      if (insertError) {
        console.error('Supabase user insert error:', insertError);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
    }

    // Upsert game
    const { data: gameData, error: gameError } = await supabase
      .from('games')
      .select('id')
      .eq('wallet', wallet.wallet)
      .eq('game_name', 'vanilla-plus')
      .single();
    if (gameError && gameError.code !== 'PGRST116') {
      console.error('Supabase game query error:', gameError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    let gameId = gameData?.id;
    if (!gameId) {
      const { data, error: insertError } = await supabase
        .from('games')
        .insert({ wallet: wallet.wallet, game_name: 'vanilla-plus' })
        .select('id')
        .single();
      if (insertError) {
        console.error('Supabase game insert error:', insertError);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
      gameId = data.id;
    }

    // Check for existing completion
    const timeFieldValue = type === 'daily' ? { date: cache.date } : { week: cache.week };
    const { data: existingHash, error: hashError } = await supabase
      .from('file_hashes')
      .select('id')
      .eq('game_id', gameId)
      .eq('wallet', wallet.wallet)
      .eq(type === 'daily' ? 'date' : 'week', timeFieldValue[type === 'daily' ? 'date' : 'week'])
      .eq('type', type)
      .single();
    if (hashError && hashError.code !== 'PGRST116') {
      console.error('Supabase hash query error:', hashError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (existingHash) {
      return NextResponse.json({ error: `${type.charAt(0).toUpperCase() + type.slice(1)} log already exists` }, { status: 409 });
    }

    // Insert new file_hash
    const computedFileHash = crypto.createHash('sha256').update(JSON.stringify(cache)).digest('hex');
    if (computedFileHash !== fileHash) {
      return NextResponse.json({ error: 'File hash mismatch' }, { status: 400 });
    }

    const { error } = await supabase.from('file_hashes').insert({
      game_id: gameId,
      wallet: wallet.wallet,
      file_hash: fileHash,
      type,
      date: type === 'daily' ? cache.date : null,
      week: type === 'weekly' ? cache.week : null,
      minted: false,
    });

    if (error) {
      console.error('Supabase insert error:', error);
      return NextResponse.json({ error: `Failed to log ${type}: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('Auth ping error:', { error: err.message });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}


