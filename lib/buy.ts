import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DEMO_TOKEN, TOKENS } from '@trial/shared';
import { erc20Abi, formatUnits, isAddress, isAddressEqual, parseEventLogs, type Address, type Hex } from 'viem';
import { publicClient } from './clients.js';
import { env, roleKey } from './env.js';

/**
 * The `buy` CLI (npm @celo/buy) is the defendant's wallet for x402. State
 * lives under BUY_HOME inside the repo. Since @celo/buy 0.8 the plaintext
 * file keystore refuses mainnet accounts, so the default is the OS keychain
 * (`system`); the first access on a new machine asks once, answer "Always
 * Allow". Override with BUY_KEYSTORE_BACKEND=file for a testnet rehearsal.
 */
export const ACCOUNT = 'defendant';

/**
 * How to start the buy CLI. The installed package's JS entry runs under this
 * node, which works on Windows too, where node_modules/.bin/buy is a shell
 * script that spawn cannot start. Falls back to `buy` on PATH.
 */
export function buyCommand(): { command: string; args: string[] } {
  try {
    const pkg = createRequire(import.meta.url).resolve('@celo/buy/package.json');
    return { command: process.execPath, args: [join(dirname(pkg), 'dist', 'main.js')] };
  } catch {
    return { command: 'buy', args: [] };
  }
}

export function buyEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BUY_HOME: resolve(env.buyHome),
    // buy 0.8 signs on mainnet only from the OS keychain ("system"); its plaintext "file" backend is for development.
    BUY_KEYSTORE_BACKEND: process.env.BUY_KEYSTORE_BACKEND || 'system',
    ...extra,
  };
}

export function runBuy(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const buy = buyCommand();
    const child = spawn(buy.command, [...buy.args, ...args], { env: buyEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export interface Receipt {
  id?: string;
  account?: string;
  url: string;
  network: string;
  asset: string;
  amount: string;
  scheme?: string;
  txHash?: string;
  authorization?: { from: string; nonce: string; validAfter: string; validBefore: string };
  timestamp?: string | number;
  status?: string;
  outcome?: string;
}

/**
 * buy keeps its receipts as versioned files, receipts.<n>.json, the highest
 * number being the current list (@celo/buy-keystore 0.8). Older releases wrote
 * receipts.json, read when no versioned file exists.
 */
export function readReceipts(): Receipt[] {
  const dir = resolve(env.buyHome);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const versions = names
    .map((n) => n.match(/^receipts\.(\d+)\.json$/)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
  for (const v of versions) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, `receipts.${v}.json`), 'utf8'));
      if (Array.isArray(parsed)) return parsed as Receipt[];
    } catch {
      /* pruned between listing and reading: the next one down */
    }
  }
  const legacy = join(dir, 'receipts.json');
  if (!existsSync(legacy)) return [];
  const parsed = JSON.parse(readFileSync(legacy, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.receipts ?? []);
}

/** A receipt's amount for people: buy records it in the token's smallest unit ("10000" for 0.01 USD₮). */
export function paidAmount(amount: string | undefined, asset: string | undefined): { amount: string; symbol?: string; amountAtomic?: string; label: string } {
  const token = Object.values(TOKENS).find((t) => asset && (isAddress(asset) ? isAddressEqual(t.address, asset) : t.symbol === asset.toUpperCase()));
  if (amount && /^\d+$/.test(amount) && token) {
    const whole = formatUnits(BigInt(amount), token.decimals);
    return { amount: whole, symbol: token.display, amountAtomic: amount, label: `${whole} ${token.display}` };
  }
  return { amount: amount ?? '?', symbol: token?.display, label: `${amount ?? '?'} ${token?.display ?? asset ?? ''}`.trim() };
}

/**
 * Who a settlement paid, from its ERC-20 Transfer log on Celo: buy's receipts do not record payTo. The
 * transfer must be from the payer, in the asset and, when the receipt says, of exactly its amount (atomic):
 * the hash comes from the provider's payment response, so it is matched, not trusted.
 */
export async function settlementPayee(txHash: Hex, payer: Address, asset?: string, amountAtomic?: string): Promise<Address | undefined> {
  const { logs } = await publicClient.getTransactionReceipt({ hash: txHash });
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs });
  const exact = amountAtomic && /^\d+$/.test(amountAtomic) ? BigInt(amountAtomic) : undefined;
  return transfers.find((t) => isAddressEqual(t.args.from, payer) && (!asset || !isAddress(asset) || isAddressEqual(t.address, asset)) && (exact === undefined || t.args.value === exact))?.args.to;
}

/** Human figures for a receipt: amount is stored in atomic units and asset as an address. */
export function describeReceipt(r: Receipt): { amount: string; asset: string } {
  const atomic = /^\d+$/.test(r.amount);
  const symbol = r.asset.toLowerCase() === DEMO_TOKEN.address.toLowerCase() ? DEMO_TOKEN.display : r.asset.startsWith('0x') ? `${r.asset.slice(0, 6)}…` : r.asset;
  return { amount: atomic ? formatUnits(BigInt(r.amount), DEMO_TOKEN.decimals) : r.amount, asset: symbol };
}

/** Receipts newer than `since`, newest first. */
export function receiptsSince(since: number): Receipt[] {
  return readReceipts()
    .filter((r) => toMs(r.timestamp) >= since)
    .sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp));
}

function toMs(t: string | number | undefined): number {
  if (t === undefined) return 0;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  return Number.isNaN(n) ? Number(t) || 0 : n;
}

/** Idempotent: import the defendant key into the file keystore once. */
export async function ensureBuyAccount(): Promise<{ created: boolean; address?: string }> {
  const who = await runBuy(['--account', ACCOUNT, 'whoami', '--json']);
  if (who.code === 0) {
    const addr = who.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0];
    return { created: false, address: addr };
  }
  const r = await runBuy(['setup', '--import', '--name', ACCOUNT], { env: { BUY_IMPORT_KEY: roleKey('agent') } });
  if (r.code !== 0) throw new Error(`buy setup failed: ${r.stderr || r.stdout}`);
  const addr = r.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0];
  return { created: true, address: addr };
}

export async function buyWhoami(): Promise<string> {
  const r = await runBuy(['--account', ACCOUNT, 'whoami']);
  return (r.stdout + r.stderr).trim();
}

/** Args for `buy mcp serve` so the agent loop can spawn it over stdio. */
export function mcpServeCommand(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const buy = buyCommand();
  return { command: buy.command, args: [...buy.args, 'mcp', 'serve', '--account', ACCOUNT], env: buyEnv() };
}
