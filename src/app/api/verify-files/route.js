// api/verify-files/route.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';
import { prepareContractCall, sendTransaction } from 'thirdweb';
import { gameContractMoneyDAO, gameContractSourceDAO } from '@/utils/functionDump/getContracts';
import { privateKeyToAccount } from 'thirdweb/wallets';

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

export async function POST(req) {
  try {
    console.log('Received POST request to /api/verify-files');

    // Parse form data
    const formData = await req.formData();
    const wallet = formData.get('wallet');
    const file = formData.get('file');

    if (!wallet || !file) {
      console.error('Missing wallet or file in form data', { wallet, file: !!file });
      return NextResponse.json({ error: 'Missing wallet or file' }, { status: 400 });
    }
    console.log('Form data parsed: wallet=', wallet, 'file=', file.name);

    // Check file size (5MB = 5 * 1024 * 1024 bytes)
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      console.error('File size exceeds 5MB limit:', file.size);
      return NextResponse.json({ error: 'File size exceeds 5MB limit' }, { status: 400 });
    }

    // Read and parse JSON file
    const fileBuffer = await file.arrayBuffer();
    const fileContent = new TextDecoder().decode(fileBuffer);
    let jsonData;
    try {
      jsonData = JSON.parse(fileContent);
    } catch (error) {
      console.error('Invalid JSON file:', error);
      return NextResponse.json({ error: 'Invalid JSON file' }, { status: 400 });
    }

    if (!jsonData.dailyFiles || !jsonData.weeklyFiles) {
      console.error('JSON missing dailyFiles or weeklyFiles keys:', jsonData);
      return NextResponse.json({ error: 'JSON must contain dailyFiles and weeklyFiles keys' }, { status: 400 });
    }

    // Extract accountName (assuming it’s consistent across entries)
    const accountName = jsonData.dailyFiles?.[0]?.daily?.accountName || jsonData.weeklyFiles?.[0]?.weekly?.accountName;
    if (!accountName) {
      console.error('Account name not found in JSON');
      return NextResponse.json({ error: 'Account name not found in JSON' }, { status: 400 });
    }

    // Fetch secrets
    const { SUPABASE_URL, SUPABASE_KEY, SERVER_WALLET_PASSWORD } = await getSecrets();
    if (!SUPABASE_URL || !SUPABASE_KEY || !SERVER_WALLET_PASSWORD) {
      console.error('Missing required secrets');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Initialize server wallet
    const serverAccount = privateKeyToAccount({
      client: { clientId: process.env.THIRDWEB_CLIENT_ID },
      privateKey: SERVER_WALLET_PASSWORD,
    });

    // Verify wallet owns accountName
    const { data: accountData, error: accountError } = await supabase
      .from('accounts')
      .select('wallet')
      .eq('account_name', accountName)
      .single();
    if (accountError || !accountData) {
      console.error('Account not found or error:', accountError);
      return NextResponse.json({ error: 'Invalid account name' }, { status: 400 });
    }
    if (accountData.wallet !== wallet) {
      console.error('Wallet does not match account:', { wallet, accountWallet: accountData.wallet });
      return NextResponse.json({ error: 'Wallet does not own this account' }, { status: 403 });
    }

    // Process daily and weekly files
    let dailyCount = 0;
    let weeklyCount = 0;

    // Process daily files
    for (const item of jsonData.dailyFiles) {
      if (!item.daily || item.daily.accountName !== accountName) {
        console.warn('Skipping invalid daily item:', item);
        continue;
      }
      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.daily)).digest('hex');
      const { data: existingHash, error } = await supabase
        .from('file_hashes')
        .select('id, minted')
        .eq('account_name', accountName)
        .eq('file_hash', fileHash)
        .eq('type', 'daily')
        .eq('date', item.daily.date)
        .eq('minted', false)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Supabase query error (daily):', error);
        continue;
      }
      if (existingHash && !existingHash.minted) {
        await supabase.from('file_hashes').update({ minted: true }).eq('id', existingHash.id);
        dailyCount++;
      }
    }

    // Process weekly files
    for (const item of jsonData.weeklyFiles) {
      if (!item.weekly || item.weekly.accountName !== accountName) {
        console.warn('Skipping invalid weekly item:', item);
        continue;
      }
      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.weekly)).digest('hex');
      const { data: existingHash, error } = await supabase
        .from('file_hashes')
        .select('id, minted')
        .eq('account_name', accountName)
        .eq('file_hash', fileHash)
        .eq('type', 'weekly')
        .eq('week', item.weekly.week)
        .eq('minted', false)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Supabase query error (weekly):', error);
        continue;
      }
      if (existingHash && !existingHash.minted) {
        await supabase.from('file_hashes').update({ minted: true }).eq('id', existingHash.id);
        weeklyCount++;
      }
    }

    // Mint tokens
    if (dailyCount > 0) {
      const transaction = prepareContractCall({
        contract: gameContractMoneyDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(dailyCount)],
      });
      await sendTransaction({ account: serverAccount, transaction });
    }

    if (weeklyCount > 0) {
      const transaction = prepareContractCall({
        contract: gameContractSourceDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(weeklyCount)],
      });
      await sendTransaction({ account: serverAccount, transaction });
    }

    console.log('Request completed successfully:', { dailyCount, weeklyCount });
    return NextResponse.json({ success: true, dailyCount, weeklyCount }, { status: 200 });
  } catch (err) {
    console.error('File upload error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}