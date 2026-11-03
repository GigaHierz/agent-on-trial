import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createFakeKleros } from '../../checks/kleros-fake.js';
import { isDryRun } from '../../lib/env.js';
import { getStorage } from '../storage/index.js';
import type { StorageAdapter } from '../storage/types.js';
import { KlerosDispute } from './kleros.js';
import { LocalDispute } from './local.js';
import type { DisputeAdapter } from './types.js';

export type { DisputeAdapter, DisputeEvidence, DisputeStatus, Ruling } from './types.js';

let cached: DisputeAdapter | null = null;

/** DISPUTE=local|kleros. Unknown values fail at startup, not mid-run. */
export function getDispute(env: NodeJS.ProcessEnv = process.env, storage: StorageAdapter = getStorage(env)): DisputeAdapter {
  if (cached) return cached;
  cached = makeDispute((env.DISPUTE ?? 'local').toLowerCase(), storage, env);
  return cached;
}

let dryRunKleros: KlerosDispute | null = null;

/**
 * --dry-run files with the Kleros adapter against the fake service, in this process: the same requests,
 * checks and records as the real one, and never the real service. Periods of DRY_RUN_PERIOD_MS (20 s)
 * each, so the first-round ruling (DRY_RUN_RULING: 1, 2, 0 or tied) is readable about a minute after filing.
 */
function dryRunDispute(storage: StorageAdapter, env: NodeJS.ProcessEnv): KlerosDispute {
  if (dryRunKleros) return dryRunKleros;
  const period = Number(env.DRY_RUN_PERIOD_MS || 20_000);
  const ruling = env.DRY_RUN_RULING === 'tied' ? 'tied' : Number(env.DRY_RUN_RULING || 1);
  // Its disputes are kept in a file, so act:ruling in another terminal, or a restarted session, reads the same ones.
  const file = '.runs/dry-run/kleros-fake.json';
  let saved: { core: number }[] = [];
  try {
    saved = JSON.parse(readFileSync(file, 'utf8')) as { core: number }[];
  } catch {
    /* first dry run */
  }
  const fake = createFakeKleros({ apiKey: 'dry-run', firstId: saved.length ? Math.max(...saved.map((d) => d.core)) + 1 : 1_000 + Math.floor(Math.random() * 900_000), periodsMs: [period, period, period, period], ruling });
  for (const d of saved) fake.disputes.set(d.core, d as never);
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fake.fetch(input, init);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([...fake.disputes.values()]));
    return res;
  }) as typeof fetch;
  dryRunKleros = new KlerosDispute(
    storage,
    {
      KLEROS_SERVICE_URL: 'http://dry-run.kleros.local/mcp',
      KLEROS_API_KEY_TESTNET: 'dry-run',
      KLEROS_CHAIN: 'arbitrum-sepolia-testnet',
      KLEROS_RULING_MAP: env.KLEROS_RULING_MAP || '1=complainant:Accept the claim,2=respondent:Reject the claim',
      KLEROS_STATE_FILE: '.runs/dry-run/kleros.json',
      KLEROS_COURT_URL: 'http://dry-run.kleros.local',
      KLEROS_POLL_MS: '5000',
    },
    { fetch: fetchFn },
  );
  return dryRunKleros;
}

export function makeDispute(which: string, storage: StorageAdapter, env: NodeJS.ProcessEnv = process.env): DisputeAdapter {
  if (isDryRun(env)) return dryRunDispute(storage, env);
  if (which === 'local') return new LocalDispute(storage);
  if (which === 'kleros') return new KlerosDispute(storage, env);
  throw new Error(`DISPUTE=${which} is not one of local, kleros`);
}
