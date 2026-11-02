import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** Accept a key with or without the 0x prefix; viem wants the prefix. */
function normalizeKey(v: string | undefined): Hex | undefined {
  if (!v || !KEY_RE.test(v)) return undefined;
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
}

export type Role = 'agent' | 'counterparty' | 'witness' | 'arbitrator' | 'jury' | 'builder' | 'shady';

/**
 * Keys by role, with the fallbacks the README promises:
 *   agent        <- AGENT_PRIVATE_KEY        <- PRIVATE_KEY
 *   counterparty <- COUNTERPARTY_PRIVATE_KEY <- PRIVATE_KEY_2
 *   witness, arbitrator, jury, builder, shady <- their own var <- counterparty
 */
export function roleKey(role: Role, env: NodeJS.ProcessEnv = process.env): Hex {
  const pick = (...names: string[]) => names.map((n) => normalizeKey(env[n])).find(Boolean);
  const counterparty = pick('COUNTERPARTY_PRIVATE_KEY', 'PRIVATE_KEY_2');
  const table: Record<Role, Hex | undefined> = {
    agent: pick('AGENT_PRIVATE_KEY', 'PRIVATE_KEY'),
    counterparty,
    witness: pick('WITNESS_PRIVATE_KEY') ?? counterparty,
    arbitrator: pick('ARBITRATOR_PRIVATE_KEY') ?? counterparty,
    jury: pick('JURY_PRIVATE_KEY') ?? counterparty,
    builder: pick('BUILDER_PRIVATE_KEY') ?? counterparty,
    shady: pick('SHADY_PRIVATE_KEY') ?? counterparty,
  };
  const key = table[role];
  if (!key) throw new Error(`no key for role ${role}; set ${roleVar(role)} (see .env.example)`);
  return key;
}

export function roleVar(role: Role): string {
  return role === 'agent'
    ? 'AGENT_PRIVATE_KEY or PRIVATE_KEY'
    : role === 'counterparty'
      ? 'COUNTERPARTY_PRIVATE_KEY or PRIVATE_KEY_2'
      : `${role.toUpperCase()}_PRIVATE_KEY or COUNTERPARTY_PRIVATE_KEY`;
}

export function roleAddress(role: Role, env: NodeJS.ProcessEnv = process.env): Address {
  return privateKeyToAccount(roleKey(role, env)).address;
}

export function hasRole(role: Role, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    roleKey(role, env);
    return true;
  } catch {
    return false;
  }
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const env = {
  trialEnv: (process.env.TRIAL_ENV ?? 'test') as 'test' | 'show',
  get round() {
    return arg('--round') ?? process.env.TRIAL_ROUND ?? this.trialEnv;
  },
  rpcUrl: process.env.CELO_RPC_URL ?? 'https://forno.celo.org',
  courtroomUrl: (process.env.COURTROOM_URL ?? '').replace(/\/$/, ''),
  hostSecret: process.env.HOST_SECRET ?? '',
  builderCode: process.env.BUILDER_CODE ?? '',
  buyHome: process.env.BUY_HOME ?? '.runs/buy',
  facilitatorApiKey: process.env.BUY_FACILITATOR_API_KEY ?? process.env.x402_API_KEY ?? process.env.X402_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  askbotsUrl: (process.env.ASKBOTS_BASE_URL ?? 'https://askbots.ai').replace(/\/$/, ''),
  askbotsCreds: process.env.ASKBOTS_CREDS ?? '.runs/askbots-agent.json',
  askbotsCronSecret: process.env.ASKBOTS_CRON_SECRET ?? '',
  agentId: process.env.AGENT_ID || undefined,
  shadyAgentId: process.env.SHADY_AGENT_ID || undefined,
  shadyPayTo: (process.env.SHADY_PAY_TO || undefined) as Address | undefined,
  storage: process.env.STORAGE ?? 'local',
  dispute: process.env.DISPUTE ?? 'local',
  /** --fixture: load the recorded exhibits for this act instead of acting. */
  fixture: flag('--fixture'),
  /** --approve: ask y/N before paying or writing to chain. */
  approve: flag('--approve'),
  /** --record: copy evidence/run.json to evidence/fixtures.json at the end of a rehearsal. */
  record: flag('--record'),
};

/** One run id per terminal session, kept in .runs/current so the act scripts share it. */
export function currentRunId(): string {
  mkdirSync('.runs', { recursive: true });
  const fromArg = arg('--run');
  if (fromArg) {
    writeFileSync('.runs/current', fromArg);
    return fromArg;
  }
  try {
    const id = readFileSync('.runs/current', 'utf8').trim();
    if (id) return id;
  } catch {
    /* first run */
  }
  return newRunId();
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const id = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync('.runs', { recursive: true });
  writeFileSync('.runs/current', id);
  return id;
}
