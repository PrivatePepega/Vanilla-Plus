import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';
import { prepareContractCall, sendTransaction, waitForReceipt  } from 'thirdweb';
import { contractMoneyDAO, contractSourceDAO } from '@/utils/functionDump/getContracts';
import { privateKeyToAccount } from 'thirdweb/wallets';
import { client } from '@/utils/thirdweb/client';

export async function POST(req) {
  try {
    console.log('Received POST request to /api/verify-files');

    const secretsManager = new SecretsManagerClient({
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.GB_ACCESS_KEY_ID,
        secretAccessKey: process.env.GB_SECRET_ACCESS_KEY,
      },
    });

    async function getSecrets() {
      try {
        const command = new GetSecretValueCommand({ SecretId: process.env.GB_SECRET_ID });
        const data = await secretsManager.send(command);
        if ('SecretString' in data) return JSON.parse(data.SecretString);
        throw new Error('Secrets not found');
      } catch (err) {
        console.error('SecretsManager error:', { error: err.message });
        throw err;
      }
    }

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
      client: { clientId: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID },
      privateKey: SERVER_WALLET_PASSWORD,
    });
    console.log('Server wallet initialized:', serverAccount?.address);



    
    // Upsert accounts for each unique accountName
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

    // Generate hashes and collect unminted IDs — DO NOT mark minted yet
    let dailyToMint = []; // { id, fileHash, date, accountName } for existing unminted rows
    let dailyToInsert = []; // new rows to insert after mint
    let weeklyToMint = []; // { id, fileHash, week, accountName } for existing unminted rows
    let weeklyToInsert = []; // new rows to insert after mint

    console.log('Hashing daily items from dailyFiles');
    for (const item of jsonData.dailyFiles) {
      if (!item.daily || !item.daily.accountName || !item.daily.date || !item.daily.wallet) {
        console.warn('Skipping invalid daily item:', item);
        continue;
      }
      if (item.daily.wallet !== wallet) {
        console.warn('Wallet mismatch in daily item:', item.daily.wallet, wallet);
        continue;
      }
      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.daily)).digest('hex');
      const { date, accountName } = item.daily;
      console.log('Generated daily hash:', fileHash, 'date:', date, 'accountName:', accountName);

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
          console.log('Found unminted daily hash, queuing for mint:', existingHash.id);
          dailyToMint.push({ id: existingHash.id, fileHash, date, accountName });
        } else {
          console.log('Daily hash already minted, skipping:', fileHash);
        }
      } else {
        console.log('New daily hash, queuing for insert after mint:', fileHash);
        dailyToInsert.push({ fileHash, date, accountName });
      }
    }

    console.log('Hashing weekly items from weeklyFiles');
    for (const item of jsonData.weeklyFiles) {
      if (!item.weekly || !item.weekly.accountName || !item.weekly.week || !item.weekly.wallet) {
        console.warn('Skipping invalid weekly item:', item);
        continue;
      }
      if (item.weekly.wallet !== wallet) {
        console.warn('Wallet mismatch in weekly item:', item.weekly.wallet, wallet);
        continue;
      }
      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.weekly)).digest('hex');
      const { week, accountName } = item.weekly;
      console.log('Generated weekly hash:', fileHash, 'week:', week, 'accountName:', accountName);

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
          console.log('Found unminted weekly hash, queuing for mint:', existingHash.id);
          weeklyToMint.push({ id: existingHash.id, fileHash, week, accountName });
        } else {
          console.log('Weekly hash already minted, skipping:', fileHash);
        }
      } else {
        console.log('New weekly hash, queuing for insert after mint:', fileHash);
        weeklyToInsert.push({ fileHash, week, accountName });
      }
    }

    const dailyCount = dailyToMint.length + dailyToInsert.length;
    const weeklyCount = weeklyToMint.length + weeklyToInsert.length;
    console.log('Daily to mint:', dailyCount, 'Weekly to mint:', weeklyCount);

    // Mint MoneyDAO tokens for daily — THEN mark in Supabase
    if (dailyCount > 0) {
      console.log('Preparing to mint MoneyDAO tokens:', dailyCount);
      const transaction = prepareContractCall({
        contract: contractMoneyDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(dailyCount)],
      });



      
      const { transactionHash } = await sendTransaction({
        account: serverAccount,
        transaction,
      });
      console.log('Credit tokens minted successfully:', transactionHash);

      const dailyReceipt = await waitForReceipt({
        client,
        chain: contractMoneyDAO.chain,
        transactionHash,
      });
      console.log('Credit tokens confirmed on-chain:', dailyReceipt.status);



      // Mint succeeded — now mark existing rows as minted
      for (const { id } of dailyToMint) {
        const { error: updateError } = await supabase
          .from('file_hashes')
          .update({ minted: true })
          .eq('id', id);
        if (updateError) console.error('Supabase update error (daily):', updateError);
        else console.log('Daily hash marked as minted:', id);
      }

      // Mint succeeded — now insert new rows as minted
      for (const { fileHash, date, accountName } of dailyToInsert) {
        const { error: insertError } = await supabase
          .from('file_hashes')
          .insert({
            account_name: accountName,
            file_hash: fileHash,
            type: 'daily',
            date,
            week: null,
            minted: true,
            wallet,
          });
        if (insertError) console.error('Supabase insert error (daily):', insertError);
        else console.log('New daily hash inserted as minted:', fileHash);
      }
    } else {
      console.log('No daily tokens to mint');
    }

    // Mint SourceDAO tokens for weekly — THEN mark in Supabase
    if (weeklyCount > 0) {
      console.log('Preparing to mint SourceDAO tokens:', weeklyCount);
      const transaction = prepareContractCall({
        contract: contractSourceDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(weeklyCount)],
      });
      const { transactionHash } = await sendTransaction({
        account: serverAccount,
        transaction,
      });
      console.log('DAO tokens minted successfully:', transactionHash);


      const weeklyReceipt = await waitForReceipt({
        client,
        chain: contractSourceDAO.chain,
        transactionHash,
      });
      console.log('DAO tokens confirmed on-chain:', weeklyReceipt.status);


      // Mint succeeded — now mark existing rows as minted
      for (const { id } of weeklyToMint) {
        const { error: updateError } = await supabase
          .from('file_hashes')
          .update({ minted: true })
          .eq('id', id);
        if (updateError) console.error('Supabase update error (weekly):', updateError);
        else console.log('Weekly hash marked as minted:', id);
      }

      // Mint succeeded — now insert new rows as minted
      for (const { fileHash, week, accountName } of weeklyToInsert) {
        const { error: insertError } = await supabase
          .from('file_hashes')
          .insert({
            account_name: accountName,
            file_hash: fileHash,
            type: 'weekly',
            date: null,
            week,
            minted: true,
            wallet,
          });
        if (insertError) console.error('Supabase insert error (weekly):', insertError);
        else console.log('New weekly hash inserted as minted:', fileHash);
      }
    } else {
      console.log('No weekly tokens to mint');
    }

    console.log('Request completed successfully:', { dailyCount, weeklyCount });
    return NextResponse.json({ success: true, dailyCount, weeklyCount }, { status: 200 });
  } catch (err) {
    console.error('File upload error:', err);
    return NextResponse.json({ error: 'Server error', details: err.message }, { status: 500 });
  }
}