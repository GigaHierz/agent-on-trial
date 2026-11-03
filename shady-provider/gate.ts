import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FACILITATOR_URL } from '@trial/shared';
import { buyBin, buyEnv } from '../lib/buy.js';
import { env, roleAddress, roleKey } from '../lib/env.js';
import { log } from '../lib/log.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SHADY_PORT = Number(process.env.SHADY_PORT ?? 4402);
export const SHADY_BASE = `http://localhost:${SHADY_PORT}`;
export const SHADY_REPORT_URL = `${SHADY_BASE}/report/celo`;

export interface Gate {
  payTo: string;
  stop: () => Promise<void>;
}

/**
 * Start the shady paywall with `buy gate` and wait until /health answers.
 * payTo is templated into a copy under .runs/ because the YAML has no env
 * interpolation. The facilitator settles for real: this is mainnet.
 */
export async function startShadyGate(): Promise<Gate> {
  if (env.dryRun) {
    // The scripted seller (agent/tools/dry-run-buy.ts) plays the gate: nothing listens, nothing settles.
    const payTo = env.shadyPayTo ?? roleAddress('shady');
    log.ops(`dry run: the shady provider at ${SHADY_REPORT_URL} is played in this process · payTo ${payTo} · 0.01 USD₮ per report, never settled`);
    return { payTo, stop: async () => {} } as unknown as Gate;
  }
  // With a facilitator key the Celo facilitator settles. Without one the shady provider settles its own sales
  // (buy gate's sponsor mode): the shady key submits the buyer's signed transfer and pays its gas.
  const apiKey = env.facilitatorApiKey;
  const payTo = env.shadyPayTo ?? roleAddress('shady');
  const yml = readFileSync(join(here, 'paywall.yml'), 'utf8').replace('__SHADY_PAY_TO__', payTo);
  mkdirSync('.runs', { recursive: true });
  const path = join('.runs', 'shady-paywall.yml');
  writeFileSync(path, yml);

  const args = apiKey ? ['gate', path, '--facilitator', FACILITATOR_URL, '--port', String(SHADY_PORT)] : ['gate', path, '--port', String(SHADY_PORT)];
  const child: ChildProcess = spawn(buyBin(), args, {
    env: buyEnv(apiKey ? { BUY_FACILITATOR_API_KEY: apiKey } : { BUY_GATE_SPONSOR_KEY: roleKey('shady') }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`buy gate exited ${child.exitCode}: ${output.slice(-400)}`);
    try {
      const res = await fetch(`${SHADY_BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  log.info(`shady provider up at ${SHADY_REPORT_URL} · 0.01 USD₮ per report`);
  log.ops(`shady gate: payTo ${payTo} · ${apiKey ? `facilitator ${FACILITATOR_URL}` : `settled by the shady key itself (no facilitator key)`}`);
  return {
    payTo,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 3000);
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startShadyGate()
    .then((g) => {
      log.host(`shady provider serving; Ctrl-C to stop. Try: pnpm exec buy --account defendant curl --token USDT ${SHADY_REPORT_URL}`);
      process.on('SIGINT', () => g.stop().then(() => process.exit(0)));
    })
    .catch((err) => {
      log.error(String(err));
      process.exit(1);
    });
}
