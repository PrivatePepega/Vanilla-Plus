import { createClient } from '@supabase/supabase-js';
import { chainById } from '@/utils/thirdweb/chains';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';
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
  const serverPublicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6lf5oWbDy1X0Cgq2ExZI
DV+6PDoTZit0DpGcswwcTuhWhDacg3aAhcuDW7aWo5cETMhhJGwxueixRg1C8nvr
dHalIE8S3rXrHiEh2AQX91w6Yg1SemUA6ves+2Tw9Ir1pKjFTsghjMGT1bIBe674
u8h1AUf7hSTh1AHeiWfxY6SxCx6na50ZC5Ye0ryIHajukLd4e5Y08Lyza074Ijsj
yRiIvZ1QXHhANqI7diFKP4s1zblYVqc9EFbb3g2zw8fGdCz7E0Ax5pR5lFSVCS55
J3KZA4whyoSYdclDJ6QWkFUO4ZeDetqdT2FQAyHGQPFeiCRxYhE/FeK/aH2ZAyKP
EQIDAQAB
-----END PUBLIC KEY-----`;




  try {
    const { wallet, publicKey, signedMessage, game, type, cache } = await request.json();

    if (!wallet || !publicKey || !signedMessage || !game || !type || !cache) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const { SUPABASE_URL, SUPABASE_KEY, APP_SECRET, SERVER_WALLET_PASSWORD, RSA_PUBLIC, RSA_PRIVATE } = await getSecrets();


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

          formattedPrivateKey = formatPemKey(RSA_PRIVATE);

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

    const [fileHash, gameName, secret, userPassword, signedType, timeField, accountName] = decrypted;

console.log("say accountName:", accountName);


    // Validate inputs
    if (secret !== APP_SECRET) return NextResponse.json({ error: 'Invalid app secret' }, { status: 401 });
    if (game !== gameName || type !== signedType) return NextResponse.json({ error: 'Mismatched game or type' }, { status: 400 });
    if (game !== 'vanilla-plus') return NextResponse.json({ error: 'Invalid game' }, { status: 400 });
    if (!['daily', 'weekly'].includes(type)) return NextResponse.json({ error: 'Invalid type' }, { status: 400 });

    // Verify blockchain password
    try {

      const blockchainPasswordHash = await readContract({
        contract: contractPassport,
        method: "function viewUserPassword(address _user) view returns (string memory)",
        params: [wallet]
      });


      // const userPasswordHash = crypto.createHash('sha256').update(userPassword).digest('hex');
      if (blockchainPasswordHash !== userPassword) {
        return NextResponse.json({ error: 'Blockchain auth failed' }, { status: 401 });
      }
    } catch (err) {
      console.error('Thirdweb blockchain error:', { error: err.message });
      return NextResponse.json({ error: 'Blockchain verification failed' }, { status: 500 });
    }


    

    // NEW: Upsert account in accounts table
    // Ensures the account_name exists for the specific game_name. If not, inserts it.
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('account_name')
      .eq('account_name', accountName)
      .eq('game_name', 'vanilla-plus')
      .single();
    if (accountError && accountError.code !== 'PGRST116') {
      console.error('Supabase account query error:', accountError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (!account) {
      const { error: insertError } = await supabase
        .from('accounts')
        .insert({ account_name: accountName, game_name: 'vanilla-plus' });
      if (insertError) {
        console.error('Supabase account insert error:', insertError);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
    }

    // NEW: Check for existing file hash
    // Queries file_hashes to prevent duplicate daily/weekly completions for the account_name.
    const timeFieldValue = type === 'daily' ? cache.date : cache.week;
    const { data: existingHash, error: hashError } = await supabase
      .from('file_hashes')
      .select('id')
      .eq('account_name', accountName)
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


    // NEW: Insert new file hash
    // Inserts the file hash into file_hashes, tied to account_name, with wallet for minting.
    const computedFileHash = crypto.createHash('sha256').update(JSON.stringify(cache)).digest('hex');
    if (computedFileHash !== fileHash) {
      return NextResponse.json({ error: 'File hash mismatch' }, { status: 400 });
    }
    const { error } = await supabase
      .from('file_hashes')
      .insert({
        account_name: accountName,
        file_hash: fileHash,
        type,
        date: type === 'daily' ? cache.date : null,
        week: type === 'weekly' ? cache.week : null,
        minted: false,
        wallet,
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

