import 'dotenv/config';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';

// Venue and hotel networks often advertise IPv6 without routing it; Node's fetch
// then times out with a bare "fetch failed" while curl works (measured on 3 Nov:
// curl -6 fails, curl -4 works, fetch needs both settings below). Prefer IPv4 and
// stop Node from racing the IPv6 address for every outbound call this process makes.
// Child processes get the same through NODE_OPTIONS (see lib/buy.ts).
setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);
export const IPV4_NODE_OPTIONS = '--dns-result-order=ipv4first --no-network-family-autoselection';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, type Address, type Hex } from 'viem';

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
  // A dry run signs nothing: a role with no key gets a stand-in, three distinct wallets as the show needs.
  const standIn = (r: string) => (isDryRun(env) ? keccak256(toHex(`agent-on-trial dry run ${r}`)) : undefined);
  const counterparty = pick('COUNTERPARTY_PRIVATE_KEY', 'PRIVATE_KEY_2') ?? standIn('counterparty');
  const table: Record<Role, Hex | undefined> = {
    agent: pick('AGENT_PRIVATE_KEY', 'PRIVATE_KEY') ?? standIn('agent'),
    counterparty,
    witness: pick('WITNESS_PRIVATE_KEY') ?? counterparty,
    arbitrator: pick('ARBITRATOR_PRIVATE_KEY') ?? counterparty,
    jury: pick('JURY_PRIVATE_KEY') ?? counterparty,
    builder: pick('BUILDER_PRIVATE_KEY') ?? counterparty,
    shady: pick('SHADY_PRIVATE_KEY') ?? (isDryRun(env) && !pick('COUNTERPARTY_PRIVATE_KEY', 'PRIVATE_KEY_2') ? standIn('shady') : counterparty),
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

/**
 * --dry-run (or DRY_RUN=1): rehearse with the real model and no money moving. The shady seller is
 * scripted (no x402 payment), Kleros is a stand-in in this process, feedback is checked and logged but
 * never signed, and the run, its files and its courtroom round are its own.
 */
export function isDryRun(e: NodeJS.ProcessEnv = process.env): boolean {
  return flag('--dry-run') || e.DRY_RUN === '1';
}
const dryRun = isDryRun();
// Children (pnpm, tsx, buy) inherit the mode: a dry run never spawns a live act.
if (dryRun) process.env.DRY_RUN = '1';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function ms(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const env = {
  trialEnv: (process.env.TRIAL_ENV ?? 'test') as 'test' | 'show',
  get round() {
    return arg('--round') ?? process.env.TRIAL_ROUND ?? (dryRun ? 'dryrun' : this.trialEnv);
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
  // A dry run without identities uses stand-in ids, far above any minted one (reads of them find nothing).
  agentId: process.env.AGENT_ID || (dryRun ? '999999001' : undefined),
  shadyAgentId: process.env.SHADY_AGENT_ID || (dryRun ? '999999002' : undefined),
  shadyPayTo: (process.env.SHADY_PAY_TO || undefined) as Address | undefined,
  storage: process.env.STORAGE ?? 'local',
  dispute: process.env.DISPUTE ?? 'local',
  /** --fixture: load the recorded exhibits for this act instead of acting. */
  fixture: flag('--fixture'),
  /** --step: in the session, an empty line runs the next step of the show; a failed step offers the recorded replay. */
  step: flag('--step'),
  /** --approve: ask y/N before paying or writing to chain. */
  approve: flag('--approve'),
  /** --record: copy evidence/run.json to evidence/fixtures.json at the end of a rehearsal. */
  record: flag('--record'),
  dryRun,
  /**
   * --scripted-agent (or SCRIPTED_AGENT=1): act dispute's turn is played by a script that calls the act's own
   * tools in the order its task asks, with no model and no ANTHROPIC_API_KEY. Everything else stays as it is
   * (live, or dry with --dry-run). For testing the dispute path; on stage the model plays the turn.
   */
  scriptedAgent: flag('--scripted-agent') || process.env.SCRIPTED_AGENT === '1',
  /**
   * How long act dispute waits for the ruling before it moves on, in ms (RULING_WAIT_MS, default 0). A Kleros
   * vote takes twenty minutes to over an hour: the session watches for it in the background (/ruling), and
   * pnpm act:ruling writes it from any terminal.
   */
  rulingWaitMs: ms(process.env.RULING_WAIT_MS, 0),
  /** How often the session's background watch reads the ruling, in ms (RULING_POLL_MS, default 20 s). */
  rulingPollMs: Math.max(1_000, ms(process.env.RULING_POLL_MS, 20_000)),
};

/** Where a dry run keeps what a real run keeps under .runs/ and evidence/: never the real run's files. */
export const RUN_DIR = dryRun ? '.runs/dry-run' : '.runs';
export const CURRENT_RUN_FILE = `${RUN_DIR}/current`;
const CURRENT = CURRENT_RUN_FILE;

/** One run id per terminal session, kept in .runs/current so the act scripts share it. */
export function currentRunId(): string {
  mkdirSync(RUN_DIR, { recursive: true });
  const fromArg = arg('--run');
  if (fromArg) {
    writeFileSync(CURRENT, fromArg);
    return fromArg;
  }
  try {
    const id = readFileSync(CURRENT, 'utf8').trim();
    if (id) return id;
  } catch {
    /* first run */
  }
  return newRunId();
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const id = `${dryRun ? 'dry-' : ''}${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(CURRENT, id);
  return id;
}
