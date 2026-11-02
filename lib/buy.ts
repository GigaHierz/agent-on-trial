import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env, roleKey } from './env.js';

/**
 * The `buy` CLI (npm @celo/buy) is the defendant's wallet for x402. State
 * lives under BUY_HOME inside the repo. Since @celo/buy 0.8 the plaintext
 * file keystore refuses mainnet accounts, so the default is the OS keychain
 * (`system`); the first access on a new machine asks once, answer "Always
 * Allow". Override with BUY_KEYSTORE_BACKEND=file for a testnet rehearsal.
 */
export const ACCOUNT = 'defendant';

export function buyBin(): string {
  const local = resolve('node_modules/.bin/buy');
  return existsSync(local) ? local : 'buy';
}

export function buyEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BUY_HOME: resolve(env.buyHome),
    BUY_KEYSTORE_BACKEND: process.env.BUY_KEYSTORE_BACKEND ?? 'system',
    ...extra,
  };
}

export function runBuy(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(buyBin(), args, { env: buyEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
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

export function readReceipts(): Receipt[] {
  const path = join(resolve(env.buyHome), 'receipts.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const list: Receipt[] = Array.isArray(parsed) ? parsed : (parsed.receipts ?? []);
  return list;
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
  return { command: buyBin(), args: ['mcp', 'serve', '--account', ACCOUNT], env: buyEnv() };
}
