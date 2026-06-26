import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';
import { prepareContractCall, sendTransaction, waitForReceipt } from 'thirdweb';
import { contractMoneyDAO, contractSourceDAO } from '@/utils/functionDump/getContracts';
import { privateKeyToAccount } from 'thirdweb/wallets';
import { client } from '@/utils/thirdweb/client';



export async function POST(req) {
  try {
    console.log('Received POST request to /api/verify-files');


    
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


    // --- Parse form data ---
    const formData = await req.formData();
    const wallet = formData.get('wallet');
    const file = formData.get('file');

    if (!wallet || !file) {
      console.error('Missing wallet or file');
      return NextResponse.json({ error: 'Missing wallet or file' }, { status: 400 });
    }
    console.log('Form data parsed: wallet=', wallet, 'file=', file.name);

    // --- File size check ---
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File size exceeds 5MB limit' }, { status: 400 });
    }

    // --- Parse JSON ---
    const fileBuffer = await file.arrayBuffer();
    const fileContent = new TextDecoder().decode(fileBuffer);
    let jsonData;
    try {
      jsonData = JSON.parse(fileContent);
    } catch (err) {
      return NextResponse.json({ error: 'Invalid JSON file' }, { status: 400 });
    }

    if (!jsonData.dailyFiles || !jsonData.weeklyFiles) {
      return NextResponse.json({ error: 'JSON must contain dailyFiles and weeklyFiles keys' }, { status: 400 });
    }
    console.log('JSON parsed:', {
      dailyFilesCount: jsonData.dailyFiles.length,
      weeklyFilesCount: jsonData.weeklyFiles.length,
    });

    const gameName = 'vanilla-plus';

    // --- Fetch secrets ---
    const { SUPABASE_URL, SUPABASE_KEY, SERVER_WALLET_PASSWORD } = await getSecrets();
    if (!SUPABASE_URL || !SUPABASE_KEY || !SERVER_WALLET_PASSWORD) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // --- Phone verified check ---
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

    // --- Server wallet ---
    const serverAccount = privateKeyToAccount({
      client: { clientId: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID },
      privateKey: SERVER_WALLET_PASSWORD,
    });
    console.log('Server wallet initialized:', serverAccount?.address);

    // --- Build mint queues ---
    let dailyToMint = [];   // existing unminted rows { id, fileHash, date, accountName }
    let dailyToInsert = []; // new rows to insert after mint { fileHash, date, accountName }
    let weeklyToMint = [];
    let weeklyToInsert = [];

    // --- Process daily items ---
    console.log('Processing daily items');
    for (const item of jsonData.dailyFiles) {
      if (!item.daily?.accountName || !item.daily?.date || !item.daily?.wallet) {
        console.warn('Skipping invalid daily item:', item);
        continue;
      }
      if (item.daily.wallet !== wallet) {
        console.warn('Wallet mismatch in daily item:', item.daily.wallet, wallet);
        continue;
      }

      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.daily)).digest('hex');
      const { date, accountName } = item.daily;
      console.log('Daily hash:', fileHash, 'date:', date, 'accountName:', accountName);

      const { data: existingHash, error } = await supabase
        .from('file_hashes')
        .select('id, minted')
        .eq('account_name', accountName)
        .eq('game_name', gameName)
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
          console.log('Queuing unminted daily for mint:', existingHash.id);
          dailyToMint.push({ id: existingHash.id, fileHash, date, accountName });
        } else {
          console.log('Daily already minted, skipping:', fileHash);
        }
      } else {
        console.log('New daily, queuing for insert after mint:', fileHash);
        dailyToInsert.push({ fileHash, date, accountName });
      }
    }

    // --- Process weekly items ---
    console.log('Processing weekly items');
    for (const item of jsonData.weeklyFiles) {
      if (!item.weekly?.accountName || !item.weekly?.week || !item.weekly?.wallet) {
        console.warn('Skipping invalid weekly item:', item);
        continue;
      }
      if (item.weekly.wallet !== wallet) {
        console.warn('Wallet mismatch in weekly item:', item.weekly.wallet, wallet);
        continue;
      }

      const fileHash = crypto.createHash('sha256').update(JSON.stringify(item.weekly)).digest('hex');
      const { week, accountName } = item.weekly;
      console.log('Weekly hash:', fileHash, 'week:', week, 'accountName:', accountName);

      const { data: existingHash, error } = await supabase
        .from('file_hashes')
        .select('id, minted')
        .eq('account_name', accountName)
        .eq('game_name', gameName)
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
          console.log('Queuing unminted weekly for mint:', existingHash.id);
          weeklyToMint.push({ id: existingHash.id, fileHash, week, accountName });
        } else {
          console.log('Weekly already minted, skipping:', fileHash);
        }
      } else {
        console.log('New weekly, queuing for insert after mint:', fileHash);
        weeklyToInsert.push({ fileHash, week, accountName });
      }
    }

    const dailyCount = dailyToMint.length + dailyToInsert.length;
    const weeklyCount = weeklyToMint.length + weeklyToInsert.length;
    console.log('Daily to mint:', dailyCount, 'Weekly to mint:', weeklyCount);

    // --- Mint daily (MoneyDAO) ---
    if (dailyCount > 0) {
      console.log('Minting MoneyDAO tokens:', dailyCount);
      const transaction = prepareContractCall({
        contract: contractMoneyDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(dailyCount)],
      });

      const { transactionHash } = await sendTransaction({ account: serverAccount, transaction });
      console.log('Daily tokens minted:', transactionHash);

      const dailyReceipt = await waitForReceipt({
        client,
        chain: contractMoneyDAO.chain,
        transactionHash,
      });
      console.log('Daily mint confirmed:', dailyReceipt.status);

      // Mark existing unminted rows as minted
      for (const { id } of dailyToMint) {
        const { error: updateError } = await supabase
          .from('file_hashes')
          .update({ minted: true })
          .eq('id', id);
        if (updateError) console.error('Supabase update error (daily):', updateError);
        else console.log('Daily marked as minted:', id);
      }

      // Insert new rows as minted
      for (const { fileHash, date, accountName } of dailyToInsert) {
        const { error: insertError } = await supabase
          .from('file_hashes')
          .insert({
            account_name: accountName,
            game_name: gameName,
            file_hash: fileHash,
            type: 'daily',
            date,
            week: null,
            minted: true,
            wallet,
          });
        if (insertError) console.error('Supabase insert error (daily):', insertError);
        else console.log('New daily inserted as minted:', fileHash);
      }
    } else {
      console.log('No daily tokens to mint');
    }

    // --- Mint weekly (SourceDAO) ---
    if (weeklyCount > 0) {
      console.log('Minting SourceDAO tokens:', weeklyCount);
      const transaction = prepareContractCall({
        contract: contractSourceDAO,
        method: 'function Mint(address _user, uint256 _times)',
        params: [wallet, BigInt(weeklyCount)],
      });

      const { transactionHash } = await sendTransaction({ account: serverAccount, transaction });
      console.log('Weekly tokens minted:', transactionHash);

      const weeklyReceipt = await waitForReceipt({
        client,
        chain: contractSourceDAO.chain,
        transactionHash,
      });
      console.log('Weekly mint confirmed:', weeklyReceipt.status);

      // Mark existing unminted rows as minted
      for (const { id } of weeklyToMint) {
        const { error: updateError } = await supabase
          .from('file_hashes')
          .update({ minted: true })
          .eq('id', id);
        if (updateError) console.error('Supabase update error (weekly):', updateError);
        else console.log('Weekly marked as minted:', id);
      }

      // Insert new rows as minted
      for (const { fileHash, week, accountName } of weeklyToInsert) {
        const { error: insertError } = await supabase
          .from('file_hashes')
          .insert({
            account_name: accountName,
            game_name: gameName,
            file_hash: fileHash,
            type: 'weekly',
            date: null,
            week,
            minted: true,
            wallet,
          });
        if (insertError) console.error('Supabase insert error (weekly):', insertError);
        else console.log('New weekly inserted as minted:', fileHash);
      }
    } else {
      console.log('No weekly tokens to mint');
    }

    console.log('Request completed:', { dailyCount, weeklyCount });
    return NextResponse.json({ success: true, dailyCount, weeklyCount }, { status: 200 });

  } catch (err) {
    console.error('File upload error:', err);
    return NextResponse.json({ error: 'Server error', details: err.message }, { status: 500 });
  }
}