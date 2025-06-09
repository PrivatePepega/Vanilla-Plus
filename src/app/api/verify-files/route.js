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
    console.error('SecretsManager error:', { error: err.message });
    throw err;
  }
}

export async function POST(req) {
  try {
    console.log('Received POST request to /api/verify-files');

    // Parse form data
    console.log('Parsing form data');
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
    console.log('File size check passed:', file.size, 'bytes');

    // Read and parse JSON file
    console.log('Reading and parsing JSON file');
    const fileBuffer = await file.arrayBuffer();
    const fileContent = new TextDecoder().decode(fileBuffer);
    let jsonData;
    try {
      jsonData = JSON.parse(fileContent);
      console.log('JSON parsed successfully:', Object.keys(jsonData));
    } catch (error) {
      console.error('Invalid JSON file:', error);
      return NextResponse.json({ error: 'Invalid JSON file' }, { status: 400 });
    }

    if (!jsonData.dailyFiles || !jsonData.weeklyFiles) {
      console.error('JSON missing dailyFiles or weeklyFiles keys:', jsonData);
      return NextResponse.json({ error: 'JSON must contain dailyFiles and weeklyFiles keys' }, { status: 400 });
    }
    console.log('JSON contains dailyFiles and weeklyFiles keys:', {
      dailyFilesCount: jsonData.dailyFiles.length,
      weeklyFilesCount: jsonData.weeklyFiles.length,
    });

    const gameName = 'vanilla-plus';
    console.log('Game name set to:', gameName);

    // Fetch secrets
    const { SUPABASE_URL, SUPABASE_KEY, APP_SECRET, SERVER_WALLET_PASSWORD, RSA_PUBLIC, RSA_PRIVATE } = await getSecrets();

    if (!SUPABASE_URL || !SUPABASE_KEY || !SERVER_WALLET_PASSWORD) {
      console.error('Missing required secrets');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }
    console.log('Supabase and wallet secrets loaded');

    // Initialize Supabase client
    console.log('Initializing Supabase client');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('Supabase client initialized');

    // Initialize server wallet
    console.log('Initializing server wallet');
    const serverAccount = privateKeyToAccount({
      client: { clientId: process.env.THIRDWEB_CLIENT_ID },
      privateKey: SERVER_WALLET_PASSWORD,
    });
    console.log('Server wallet initialized');








    // NEW: Upsert accounts for each unique accountName
    // Extracts unique accountNames from daily and weekly files, ensures they exist in accounts table
    const accountNames = [
      ...new Set([
        ...jsonData.dailyFiles.map((item) => item.daily?.accountName).filter(Boolean),
        ...jsonData.weeklyFiles.map((item) => item.weekly?.accountName).filter(Boolean),
      ]),
    ];
    console.log('Unique accountNames:', accountNames);
    for (const accountName of accountNames) {
      const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('account_name')
        .eq('account_name', accountName)
        .eq('game_name', gameName)
        .single();
      if (accountError && accountError.code !== 'PGRST116') {
        console.error('Supabase account query error:', accountError);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
      if (!account) {
        console.log('Inserting new account:', accountName);
        const { error: insertError } = await supabase
          .from('accounts')
          .insert({ account_name: accountName, game_name: gameName });
        if (insertError) {
          console.error('Supabase account insert error:', insertError);
          return NextResponse.json({ error: 'Database error' }, { status: 500 });
        }
      }
    }











    // Process daily and weekly files
    let dailyHashes = [];
    let weeklyHashes = [];

    // Hash daily items
    console.log('Hashing daily items from dailyFiles');
    for (const item of jsonData.dailyFiles) {
      if (!item.daily) {
        console.warn('Skipping daily item missing daily key:', item);
        continue;
      }
      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.daily)).digest('hex');
      dailyHashes.push({ fileHash, date: item.daily.date || null });
      console.log('Generated daily hash:', fileHash, 'date:', item.daily.date);
    }
    console.log('Daily hashes generated:', dailyHashes.length);

    // Hash weekly items
    console.log('Hashing weekly items from weeklyFiles');
    for (const item of jsonData.weeklyFiles) {
      if (!item.weekly) {
        console.warn('Skipping weekly item missing weekly key:', item);
        continue;
      }
      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.weekly)).digest('hex');
      weeklyHashes.push({ fileHash, week: item.weekly.week || null });
      console.log('Generated weekly hash:', fileHash, 'week:', item.weekly.week);
    }
    console.log('Weekly hashes generated:', weeklyHashes.length);








 // NEW: Process daily hashes
    // Checks for existing hashes, inserts new ones, and updates minted status
    let dailyCount = 0;
    console.log('Processing daily hashes in Supabase');
    for (const { fileHash, date, accountName } of dailyHashes) {
      console.log('Checking daily hash:', fileHash, 'date:', date, 'accountName:', accountName);
      const { data: existingHash, error } = await supabase
        .from('file_hashes')
        .select('id, minted')
        .eq('account_name', accountName)
        .eq('file_hash', fileHash)
        .eq('type', 'daily')
        .eq('date', date)
        .eq('wallet', wallet)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Supabase query error (daily):', error);
        continue;
      }

      if (existingHash) {
        if (!existingHash.minted) {
          console.log('Found unminted daily hash, updating:', existingHash.id);
          const { error: updateError } = await supabase
            .from('file_hashes')
            .update({ minted: true })
            .eq('id', existingHash.id);
          if (updateError) {
            console.error('Supabase update error (daily):', updateError);
            continue;
          }
          dailyCount++;
          console.log('Daily hash marked as minted, count:', dailyCount);
        }
      } else {
        console.log('Inserting new daily hash:', fileHash);
        const { error: insertError } = await supabase
          .from('file_hashes')
          .insert({
            account_name: accountName,
            file_hash: fileHash,
            type: 'daily',
            date,
            week: null,
            minted: false,
            wallet,
          });
        if (insertError) {
          console.error('Supabase insert error (daily):', insertError);
          continue;
        }
      }
    }
    console.log('Total daily matches:', dailyCount);






 // NEW: Process weekly hashes
    // Checks for existing hashes, inserts new ones, and updates minted status
    let weeklyCount = 0;
    console.log('Processing weekly hashes in Supabase');
    for (const { fileHash, week, accountName } of weeklyHashes) {
      console.log('Checking weekly hash:', fileHash, 'week:', week, 'accountName:', accountName);
      const { data: existingHash, error } = await supabase
        .from('file_hashes')
        .select('id, minted')
        .eq('account_name', accountName)
        .eq('file_hash', fileHash)
        .eq('type', 'weekly')
        .eq('week', week)
        .eq('wallet', wallet)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Supabase query error (weekly):', error);
        continue;
      }

      if (existingHash) {
        if (!existingHash.minted) {
          console.log('Found unminted weekly hash, updating:', existingHash.id);
          const { error: updateError } = await supabase
            .from('file_hashes')
            .update({ minted: true })
            .eq('id', existingHash.id);
          if (updateError) {
            console.error('Supabase update error (weekly):', updateError);
            continue;
          }
          weeklyCount++;
          console.log('Weekly hash marked as minted, count:', weeklyCount);
        }
      } else {
        console.log('Inserting new weekly hash:', fileHash);
        const { error: insertError } = await supabase
          .from('file_hashes')
          .insert({
            account_name: accountName,
            file_hash: fileHash,
            type: 'weekly',
            date: null,
            week,
            minted: false,
            wallet,
          });
        if (insertError) {
          console.error('Supabase insert error (weekly):', insertError);
          continue;
        }
      }
    }
    console.log('Total weekly matches:', weeklyCount);

    // Mint tokens using Thirdweb
    if (dailyCount > 0) {
      console.log('Preparing to mint MoneyDAO tokens:', dailyCount);
      const transaction = prepareContractCall({
        contract: gameContractMoneyDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(dailyCount)],
      });
      const { transactionHash } = await sendTransaction({
        account: serverAccount,
        transaction,
      });
      console.log('MoneyDAO tokens minted successfully');
    } else {
      console.log('No daily tokens to mint');
    }

    if (weeklyCount > 0) {
      console.log('Preparing to mint SourceDAO tokens:', weeklyCount);
      const transaction = prepareContractCall({
        contract: gameContractSourceDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(weeklyCount)],
      });
      console.log('Sending SourceDAO mint transaction');
      const { transactionHash } = await sendTransaction({
        account: serverAccount,
        transaction,
      });
      console.log('SourceDAO tokens minted successfully');
    } else {
      console.log('No weekly tokens to mint');
    }

    console.log('Request completed successfully:', { dailyCount, weeklyCount });
    return NextResponse.json({ success: true, dailyCount, weeklyCount }, { status: 200 });
  } catch (err) {
    console.error('File upload error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}