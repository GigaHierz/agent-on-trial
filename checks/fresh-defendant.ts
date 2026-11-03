import 'dotenv/config';
import { readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, formatEther, formatUnits, erc20Abi } from 'viem';
import { celo } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEMO_TOKEN } from '@trial/shared';
import { runBuy, ACCOUNT } from '../lib/buy.js';

/**
 * pnpm fresh:defendant [--celo 0.3] [--usdt 0.5]
 *
 * A brand-new defendant for a show: new wallet, no identity, no askbots
 * account, no buy account. Funded from the treasury key (TREASURY_PRIVATE_KEY,
 * falling back to PRIVATE_KEY) so act 1 can mint and act 3 can pay.
 *
 * What it does, in order:
 *   1. generates a key and writes AGENT_PRIVATE_KEY to .env, dropping AGENT_ID
 *   2. sends CELO (gas for the mint) and USD₮ (seed money) from the treasury
 *   3. removes the buy account "defendant" so the next act imports the new key
 *   4. sets the askbots credentials aside so act 1 registers a new bot
 *   5. forgets the current run id so the next act starts a fresh run
 *
 * Nothing is deleted: old keys stay in .env as comments, old askbots creds are
 * renamed with the old agent id.
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const celoAmount = arg('--celo', '0.3');
  const usdtAmount = arg('--usdt', '0.5');
  const treasuryKey = process.env.TREASURY_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!treasuryKey) throw new Error('set TREASURY_PRIVATE_KEY (or PRIVATE_KEY) to fund the new defendant');
  const treasury = privateKeyToAccount(`0x${treasuryKey.replace(/^0x/, '')}` as `0x${string}`);

  const newKey = generatePrivateKey();
  const fresh = privateKeyToAccount(newKey);

  // 1. .env
  const envPath = '.env';
  const previous = readFileSync(envPath, 'utf8');
  const oldId = /^AGENT_ID=(\S+)/m.exec(previous)?.[1];
  const oldKey = /^AGENT_PRIVATE_KEY=(\S+)/m.exec(previous)?.[1];
  const oldAddress = oldKey ? privateKeyToAccount(oldKey as `0x${string}`).address : undefined;
  let text = previous
    .split('\n')
    .filter((l) => !/^(AGENT_PRIVATE_KEY|AGENT_ID)=/.test(l) && !/^# Defendant:/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '\n');
  text += `\n# Defendant: fresh wallet made ${new Date().toISOString().slice(0, 10)}${oldAddress ? ` (previous: ${oldAddress}${oldId ? `, agent ${oldId}` : ''})` : ''}.\nAGENT_PRIVATE_KEY=${newKey}\n`;
  writeFileSync(envPath, text, { mode: 0o600 });
  console.log(`new defendant ${fresh.address} written to .env${oldId ? ` (replaces agent ${oldId})` : ''}`);

  // 2. funding
  const pub = createPublicClient({ chain: celo, transport: http(process.env.CELO_RPC_URL ?? 'https://forno.celo.org') });
  const wallet = createWalletClient({ account: treasury, chain: celo, transport: http(process.env.CELO_RPC_URL ?? 'https://forno.celo.org') });
  const h1 = await wallet.sendTransaction({ to: fresh.address, value: parseEther(celoAmount) });
  await pub.waitForTransactionReceipt({ hash: h1 });
  const h2 = await wallet.writeContract({ address: DEMO_TOKEN.address, abi: erc20Abi, functionName: 'transfer', args: [fresh.address, parseUnits(usdtAmount, DEMO_TOKEN.decimals)] });
  await pub.waitForTransactionReceipt({ hash: h2 });
  console.log(`funded ${celoAmount} CELO https://celoscan.io/tx/${h1}`);
  console.log(`funded ${usdtAmount} ${DEMO_TOKEN.display} https://celoscan.io/tx/${h2}`);

  // 3. buy account
  const removed = await runBuy(['account', 'remove', ACCOUNT, '--force']);
  console.log(removed.code === 0 ? `buy account "${ACCOUNT}" removed; the next act imports the new key` : `buy account: ${(removed.stderr || removed.stdout).trim().slice(0, 120) || 'nothing to remove'}`);

  // 4. askbots creds
  const creds = process.env.ASKBOTS_CREDS ?? '.runs/askbots-agent.json';
  if (existsSync(creds)) {
    const aside = creds.replace(/\.json$/, `-${oldId ?? 'previous'}.json`);
    renameSync(creds, aside);
    console.log(`askbots credentials set aside as ${aside}; act 1 registers a new bot`);
  }

  // 5. run id
  rmSync('.runs/current', { force: true });

  await new Promise((r) => setTimeout(r, 4000));
  const [bal, usdt] = await Promise.all([
    pub.getBalance({ address: fresh.address }),
    pub.readContract({ address: DEMO_TOKEN.address, abi: erc20Abi, functionName: 'balanceOf', args: [fresh.address] }),
  ]);
  console.log(`balances: ${formatEther(bal)} CELO, ${formatUnits(usdt, DEMO_TOKEN.decimals)} ${DEMO_TOKEN.display}. Next: pnpm preflight, then pnpm shady:register is NOT needed (the shady provider keeps its identity).`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
