import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { canonicalJson, celoscanTx } from '@trial/shared';
import { getAddress } from 'viem';
import { withFileLock } from '../../lib/filelock.js';
import { log as appLog } from '../../lib/log.js';
import type { StorageAdapter } from '../storage/types.js';
import {
  DEFAULT_SERVICE_URL,
  KLEROS_CHAINS,
  KlerosDisputeService,
  ServiceHttpError,
  ToolError,
  type DisputeRow,
  type KlerosChain,
  type ServiceDeps,
  type ToolInfo,
} from './kleros-service.js';
import type { DisputeAdapter, DisputeEvidence, DisputeStatus, Ruling } from './types.js';

/**
 * Kleros adapter, through the Kleros Dispute Service: Kleros v2 disputes
 * without an arbitrable contract of our own. One API key per deployment; the
 * key's Preset fixes the chain, court, juror count, template and fee wallet.
 * https://docs.kleros.io/ai-tools/dispute-service/overview
 *
 *   open()   evidence_pin (the juror attachment, before filing: the evidence
 *            period starts at creation), dispute_create, evidence_submit.
 *   status() dispute_get, period mapped to evidence | open | ruled.
 *   ruling() polls dispute_get until the first-round majority is readable
 *            (the vote is over), or until Executed with KLEROS_WAIT_FOR=executed.
 *
 * Money safety. Each filing pays an arbitration fee, so a receipt is reserved
 * in KLEROS_STATE_FILE before anything is sent and is filed at most once: a
 * mined filing is returned again; one that may have been sent (status unknown,
 * a timeout, any refusal the docs do not list as "nothing sent") or that
 * reverted stops with the transaction hash for a human. The key must file on
 * KLEROS_CHAIN, and arbitrum-one (Beta, live production) needs
 * KLEROS_ALLOW_BETA=1.
 *
 * The adapter never signs on Celo. The step script writes the ruling to the
 * Celo Reputation Registry from our arbitrator key, quoting `proofUrl`.
 *
 * Verify: pnpm check:kleros, then DISPUTE=kleros pnpm check:dispute --file
 */

export type RulingMap = Map<number, { winner: Ruling['winner']; title?: string }>;

export interface KlerosConfig {
  url: string;
  /** host of url: filings are kept per service, so a fake's ids never meet real ones. */
  service: string;
  apiKey?: string;
  /** The variable apiKey came from, for messages. */
  keyVar: string;
  chain: KlerosChain;
  allowBeta: boolean;
  /** The fingerprint of instructions a human has read, for a Preset whose instructions do not name one chain. */
  trustPreset?: string;
  /** Alias slot names, when they are not the template's buyer and provider (pnpm check:kleros lists the Preset's). */
  slots: { complainant?: string; respondent?: string };
  /** Template answer value -> winner, optionally pinned to the answer's title. Unset until a human has read the template. */
  rulingMap?: RulingMap;
  /**
   * "<chain>:<core id>" of disputes whose answers a human confirmed on the Court page, for rows that come back
   * without them. Core ids are per deployment: a bare id means one on KLEROS_CHAIN.
   */
  confirmedAnswers: Set<string>;
  /** vote: the ruling once the vote is over, taken as final (no wait for the appeal). executed: once executed. */
  waitFor: 'vote' | 'executed';
  pollMs: number;
  courtUrl: string;
  stateFile: string;
  /** Publish the juror attachment to IPFS (evidence_pin). Permanent and public. */
  pin: boolean;
}

const COURT_URL: Record<KlerosChain, string> = {
  'arbitrum-one': 'https://v2.kleros.builders',
  'arbitrum-sepolia-testnet': 'https://v2-testnet.kleros.builders',
};
const EXPLORER: Record<KlerosChain, string> = {
  'arbitrum-one': 'https://arbiscan.io',
  'arbitrum-sepolia-testnet': 'https://sepolia.arbiscan.io',
};
/** One key per deployment, so both can sit in .env and KLEROS_CHAIN picks one. KLEROS_API_KEY is the fallback. */
const KEY_VAR: Record<KlerosChain, string> = {
  'arbitrum-one': 'KLEROS_API_KEY_BETA',
  'arbitrum-sepolia-testnet': 'KLEROS_API_KEY_TESTNET',
};
/** The x402 purchase dispute template's slots: the buyer (who paid, our complainant) and the provider (who was paid). */
const DEFAULT_SLOTS = { complainant: 'buyer', respondent: 'provider' } as const;
const BETA = 'KLEROS_CHAIN=arbitrum-one is Kleros v2 Beta, live production with real arbitration fees; set KLEROS_ALLOW_BETA=1 to file there';
const NO_MAP = 'KLEROS_RULING_MAP is unset: read the template answers with pnpm check:kleros --dispute <id>, then map each value (e.g. 1=complainant:<title>,2=respondent:<title>)';
const BETA_UNSURE = 'the Kleros instructions for this key mention arbitrum-one (Beta, live production) and do not say it files on the Testnet; set KLEROS_ALLOW_BETA=1 to accept that this key may file real, fee-paying disputes';

export function isKlerosChain(v: unknown): v is KlerosChain {
  return typeof v === 'string' && (KLEROS_CHAINS as readonly string[]).includes(v);
}

/** Malformed values fail here, at startup. A missing key is reported by health() and refused by open(). */
export function klerosConfig(env: NodeJS.ProcessEnv = process.env): KlerosConfig {
  const chain = (env.KLEROS_CHAIN || 'arbitrum-sepolia-testnet').trim();
  if (chain === 'arbitrum-sepolia') {
    throw new Error('KLEROS_CHAIN=arbitrum-sepolia is retired (it named the Devnet); the testing deployment is arbitrum-sepolia-testnet');
  }
  if (!isKlerosChain(chain)) throw new Error(`KLEROS_CHAIN=${chain} is not one of ${KLEROS_CHAINS.join(', ')}`);
  const raw = (env.KLEROS_WAIT_FOR || 'vote').trim().toLowerCase();
  const waitFor = raw === 'appeal' ? 'vote' : raw; // the old name of the same moment: the start of the appeal period
  if (waitFor !== 'vote' && waitFor !== 'executed') throw new Error(`KLEROS_WAIT_FOR=${raw} is not one of vote, executed`);
  const pollMs = Number(env.KLEROS_POLL_MS || 30_000);
  if (!Number.isFinite(pollMs) || pollMs < 1_000) throw new Error(`KLEROS_POLL_MS=${env.KLEROS_POLL_MS} must be at least 1000`);
  const url = env.KLEROS_SERVICE_URL || DEFAULT_SERVICE_URL;
  const keyVar = env[KEY_VAR[chain]]?.trim() ? KEY_VAR[chain] : env.KLEROS_API_KEY?.trim() ? 'KLEROS_API_KEY' : KEY_VAR[chain];
  return {
    url,
    service: hostOf(url),
    apiKey: env[keyVar]?.trim() || undefined,
    keyVar,
    chain,
    allowBeta: env.KLEROS_ALLOW_BETA === '1',
    trustPreset: env.KLEROS_TRUST_PRESET?.trim() || undefined,
    slots: { complainant: env.KLEROS_ALIAS_COMPLAINANT?.trim() || undefined, respondent: env.KLEROS_ALIAS_RESPONDENT?.trim() || undefined },
    rulingMap: env.KLEROS_RULING_MAP?.trim() ? parseRulingMap(env.KLEROS_RULING_MAP) : undefined,
    confirmedAnswers: new Set(
      (env.KLEROS_CONFIRMED_ANSWERS ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const m = x.match(/^(?:([a-z0-9-]+):)?(\d+)$/);
          if (!m || (m[1] && !isKlerosChain(m[1]))) throw new Error(`KLEROS_CONFIRMED_ANSWERS: cannot read "${x}"; expected <chain>:<core id>, e.g. arbitrum-sepolia-testnet:300`);
          return `${m[1] ?? chain}:${m[2]}`;
        }),
    ),
    waitFor,
    pollMs,
    courtUrl: (env.KLEROS_COURT_URL || COURT_URL[chain]).replace(/\/$/, ''),
    stateFile: env.KLEROS_STATE_FILE || '.runs/kleros/disputes.json',
    pin: env.KLEROS_PIN_ATTACHMENT !== '0',
  };
}

/** "1=complainant:Buyer agent wins,2=respondent:Provider wins". Values are the template's answer values, not indexes; titles are optional pins. */
export function parseRulingMap(spec: string): RulingMap {
  const map: RulingMap = new Map();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*=\s*(complainant|respondent|refused)\s*(?::\s*(.+))?$/i);
    if (!m) throw new Error(`KLEROS_RULING_MAP: cannot read "${part}"; expected <value>=complainant|respondent|refused[:<answer title>]`);
    if (Number(m[1]) === 0) throw new Error('KLEROS_RULING_MAP: 0 is always refuse to arbitrate; leave it out');
    map.set(Number(m[1]), { winner: m[2].toLowerCase() as Ruling['winner'], title: m[3]?.trim() || undefined });
  }
  if (!map.size) throw new Error('KLEROS_RULING_MAP is empty');
  return map;
}

export function rulingMapString(map?: RulingMap): string {
  return map ? [...map].map(([v, m]) => `${v}=${m.winner}${m.title ? `:${m.title}` : ''}`).join(',') : 'unset';
}

/** Short hash of an instructions string: what KLEROS_TRUST_PRESET must equal. */
export function presetFingerprint(instructions: string): string {
  return createHash('sha256').update(instructions).digest('hex').slice(0, 12);
}

/** What the key's instructions and tools/list say about its Preset. */
export interface PresetInfo {
  instructions?: string;
  /** Why initialize failed, when it did. */
  instructionsError?: string;
  fingerprint?: string;
  tools: ToolInfo[];
  canFile: boolean;
  /**
   * Where dispute_create files: the chain of the instructions' filing line
   * ("court 8, 1 jurors, on arbitrum-sepolia-testnet"), else the one deployment
   * they name, if they name exactly one. Not necessarily a chain this adapter knows.
   */
  chain?: string;
  /** The filing line, when the instructions carry exactly one. */
  filing?: PresetFiling;
  /** A reading of the instructions, nothing more. The status of a write is the truth. */
  mode: 'simulate' | 'broadcast' | 'unknown';
  /** Alias slots: dispute_create's schema properties, else the ones its description or the instructions name. */
  slots: string[];
}

export interface PresetFiling {
  court: string;
  jurors: number;
  chain: string;
}

/** Each deployment however it is written: the id, prose ("Arbitrum One", "Arbitrum Sepolia") or the release name. */
const BETA_WORDS = /arbitrum[- ]?one|\bbeta\b/i;
const TESTNET_WORDS = /arbitrum[- ]?sepolia|\btestnet\b/i;

/**
 * The service's own words for what dispute_create sends: "court 8, 1 jurors, on
 * arbitrum-sepolia-testnet". Read only when the instructions carry exactly one
 * such line, or several that agree.
 */
const FILING_LINE = /\bcourt\s+(\d+)\s*,\s*(\d+)\s+jurors?\s*,\s*on\s+([a-z][a-z0-9-]*[a-z0-9])/gi;

export function presetFiling(instructions?: string): PresetFiling | undefined {
  const lines = [...(instructions ?? '').matchAll(FILING_LINE)].map((m) => ({ court: m[1], jurors: Number(m[2]), chain: m[3].toLowerCase() }));
  if (!lines.length) return undefined;
  const first = lines[0];
  return lines.every((l) => l.court === first.court && l.jurors === first.jurors && l.chain === first.chain) ? first : undefined;
}

/**
 * Where this key files. The filing line wins; without one, the chain the
 * instructions name, only when they name exactly one deployment. Instructions
 * with filing lines that disagree name no chain. Anything else is a human's call.
 */
export function presetChain(instructions?: string): string | undefined {
  if (!instructions) return undefined;
  const filing = presetFiling(instructions);
  if (filing) return filing.chain;
  if ([...instructions.matchAll(FILING_LINE)].length) return undefined;
  const testnet = TESTNET_WORDS.test(instructions);
  const beta = BETA_WORDS.test(instructions);
  if (testnet && !beta) return 'arbitrum-sepolia-testnet';
  if (beta && !testnet) return 'arbitrum-one';
  return undefined;
}

export function presetMode(instructions?: string): PresetInfo['mode'] {
  const sim = /simulat/i.test(instructions ?? '');
  const broadcast = /broadcast|spends real/i.test(instructions ?? '');
  return sim && !broadcast ? 'simulate' : broadcast && !sim ? 'broadcast' : 'unknown';
}

/**
 * One filing, kept on disk so a fee is never paid twice and a pending ruling
 * can be read from a later process.
 *   preparing  reserved, nothing sent yet (pin, storage). Blocks other processes until stale.
 *   filing     dispute_create is on its way. Found on a later run, it means "may have been sent".
 *   unknown    may have been sent. A human resolves it (pnpm check:kleros --resolve).
 *   reverted   mined and failed: no dispute, fee returned, gas spent. A human reads why first.
 */
export interface Filing {
  /** service/chain/receiptTxHash */
  key: string;
  service: string;
  chain: KlerosChain;
  receiptTxHash: string;
  status: 'preparing' | 'filing' | 'simulated' | 'mined' | 'unknown' | 'reverted';
  /** Who holds the reservation. Every later write checks it, so a takeover of a stale one cannot be overwritten. */
  holder: string;
  pid?: number;
  updatedAt: string;
  disputeId?: string;
  coreDisputeID?: string;
  localDisputeID?: string;
  localDisputeIDUnavailable?: string;
  createTx?: string;
  /** The service named a chain we do not know: reads are refused until a human looks. */
  chainUnconfirmed?: string;
  error?: string;
  openedAt: string;
  /** Who paid whom, so a ruling can be written from this record alone. */
  parties?: { complainant: DisputeEvidence['complainant']; respondent: DisputeEvidence['respondent'] };
  /** Filed by pnpm check:dispute over no purchase: no feedback is ever written from it. */
  test?: boolean;
  /** The dispute file in our storage. */
  evidence?: { uri: string; hash: string; gatewayUrl?: string };
  attachment?: { status: 'checked' | 'published'; fileURI?: string; cid?: string };
  /** The Evidence document as first built, so a retry submits exactly that. */
  document?: { name: string; description: string };
  submission?: { status: 'submitting' | 'simulated' | 'mined' | 'unknown' | 'reverted' | 'failed' | 'skipped'; txHash?: string; error?: string };
  period?: string;
  ruling?: { period: string; value: number; tied: boolean; final: boolean; round: number; map: string; ruling: Ruling };
}

/** A reservation older than this was never sent: its process died before filing. */
export const STALE_PREPARING_MS = 30 * 60_000;

export function isStalePreparing(f: Filing, now: number): boolean {
  return f.status === 'preparing' && now - Date.parse(f.updatedAt) > STALE_PREPARING_MS;
}

/** The filing record. Every write is a read-decide-write under a lock file. */
export class FilingStore {
  constructor(readonly path: string) {}

  all(): Filing[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const parsed = JSON.parse(text) as { filings?: Filing[] };
    return Array.isArray(parsed.filings) ? parsed.filings : [];
  }

  byKey(key: string): Filing | undefined {
    return this.all().find((f) => f.key === key);
  }

  /** Read, decide and write under the lock. `fn` returns the new list (or nothing to leave it) and a result. */
  update<T>(fn: (filings: Filing[]) => { filings?: Filing[]; result: T }): T {
    return withFileLock(this.path, () => {
      const out = fn(this.all());
      if (out.filings) this.write(out.filings);
      return out.result;
    });
  }

  /** Unconditional, for records nobody else can hold (mined ones, a human's resolve). */
  save(filing: Filing) {
    this.update((all) => ({ filings: [...all.filter((f) => f.key !== filing.key), filing], result: undefined }));
  }

  /** Write `filing` only while `holder` still holds its key. False when another process took it over. */
  saveIfHeld(filing: Filing): boolean {
    return this.update((all) => {
      const current = all.find((f) => f.key === filing.key);
      if (current && current.holder !== filing.holder) return { result: false };
      return { filings: [...all.filter((f) => f.key !== filing.key), filing], result: true };
    });
  }

  /** Drop the record while `holder` still holds it: nothing was sent for it. */
  releaseIfHeld(key: string, holder: string) {
    this.update((all) => (all.some((f) => f.key === key && f.holder === holder) ? { filings: all.filter((f) => f.key !== key), result: undefined } : { result: undefined }));
  }

  private write(filings: Filing[]) {
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, filings }, null, 2));
    renameSync(tmp, this.path);
  }
}

export interface KlerosDeps extends ServiceDeps {
  /** opsWarn, when given, takes the warnings for the operator only (a failed read that is retried). */
  log?: { info: (text: string) => void; warn: (text: string) => void; opsWarn?: (text: string) => void };
}

type Opened = Awaited<ReturnType<DisputeAdapter['open']>>;

export class KlerosDispute implements DisputeAdapter {
  readonly name = 'kleros' as const;
  readonly config: KlerosConfig;
  readonly service: KlerosDisputeService;
  readonly store: FilingStore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: NonNullable<KlerosDeps['log']>;
  private presetInfo?: Promise<PresetInfo>;
  private readonly inflight = new Map<string, Promise<Opened>>();

  constructor(
    private readonly storage: StorageAdapter,
    env: NodeJS.ProcessEnv = process.env,
    deps: KlerosDeps = {},
  ) {
    this.config = klerosConfig(env);
    this.service = new KlerosDisputeService({ url: this.config.url, apiKey: this.config.apiKey ?? '', ...deps });
    this.store = new FilingStore(this.config.stateFile);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? appLog;
  }

  caseUrl(coreDisputeID: string, chain: KlerosChain = this.config.chain): string {
    const base = chain === this.config.chain ? this.config.courtUrl : COURT_URL[chain];
    return `${base}/#/cases/${coreDisputeID}/overview`;
  }

  txUrl(hash: string, chain: KlerosChain = this.config.chain): string {
    return `${EXPLORER[chain]}/tx/${hash}`;
  }

  keyOf(receiptTxHash: string): string {
    return `${this.config.service}/${this.config.chain}/${receiptTxHash.toLowerCase()}`;
  }

  /**
   * The filing behind a dispute id, through this service. Core ids are unique
   * per chain, so KLEROS_CHAIN decides between chains; the same id twice on one
   * chain only happens with a restarted fake, and the newest wins.
   */
  findFiling(disputeId: string, ref?: string): Filing | undefined {
    if (ref) {
      // The caller knows which filing it means (a pending ruling carries it): that one or none.
      const f = this.store.byKey(ref);
      if (!f || f.disputeId !== disputeId) throw new Error(`the filing ${ref} for dispute ${disputeId} is not in ${this.store.path}; it was filed through another state file`);
      return f;
    }
    const all = this.store.all().filter((f) => f.disputeId === disputeId);
    const here = all.filter((f) => f.service === this.config.service);
    if (all.length && !here.length) throw new Error(`dispute ${disputeId} was filed through ${all[0].service}, not ${this.config.service}; set KLEROS_SERVICE_URL to read it`);
    if (here.length <= 1) return here[0];
    const chains = new Set(here.map((f) => f.chain));
    const pool = chains.size > 1 ? here.filter((f) => f.chain === this.config.chain) : here;
    if (!pool.length) throw new Error(`dispute ${disputeId} exists on ${[...chains].join(' and ')} in ${this.store.path}; set KLEROS_CHAIN to the one you mean`);
    const newest = [...pool].sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
    if (pool.length > 1) this.log.warn(`dispute ${disputeId} is in ${this.store.path} ${pool.length} times on ${newest.chain} via ${newest.service} (a restarted fake?); using the newest, receipt ${newest.receiptTxHash}`);
    return newest;
  }

  /**
   * initialize + tools/list. Cached for the process unless `fresh`; a read
   * that failed, or came back without instructions, is never cached.
   */
  preset(fresh = false): Promise<PresetInfo> {
    if (fresh) this.presetInfo = undefined;
    this.presetInfo ??= (async () => {
      let instructions: string | undefined;
      let instructionsError: string | undefined;
      try {
        instructions = (await this.service.initialize()).instructions || undefined;
      } catch (err) {
        if (err instanceof ServiceHttpError && err.status === 401) throw err;
        instructionsError = (err as Error).message.split('\n')[0];
      }
      const tools = await this.service.listTools();
      const create = tools.find((t) => t.name === 'dispute_create');
      return {
        instructions,
        instructionsError,
        fingerprint: instructions ? presetFingerprint(instructions) : undefined,
        tools,
        canFile: Boolean(create) && tools.some((t) => t.name === 'evidence_submit'),
        chain: presetChain(instructions),
        filing: presetFiling(instructions),
        mode: presetMode(instructions),
        slots: presetSlots(create?.inputSchema?.properties?.aliases, instructions),
      };
    })();
    const p = this.presetInfo;
    p.then(
      (info) => {
        if (!info.instructions && this.presetInfo === p) this.presetInfo = undefined;
      },
      () => {
        if (this.presetInfo === p) this.presetInfo = undefined;
      },
    );
    return p;
  }

  /** At most one filing per receipt: a second call while the first runs gets the first call's result. */
  open(evidence: DisputeEvidence): Promise<Opened> {
    const key = this.keyOf(evidence.receipt.txHash);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.openOnce(key, evidence).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async openOnce(key: string, evidence: DisputeEvidence): Promise<Opened> {
    const { chain, service } = this.config;
    const openedAt = new Date(this.now()).toISOString();
    const holder = `${process.pid}-${openedAt}-${Math.random().toString(36).slice(2, 10)}`;
    const base: Filing = {
      key,
      service,
      chain,
      receiptTxHash: evidence.receipt.txHash.toLowerCase(),
      status: 'preparing',
      holder,
      pid: process.pid,
      updatedAt: openedAt,
      openedAt,
      parties: { complainant: evidence.complainant, respondent: evidence.respondent },
      test: evidence.test ? true : undefined,
    };
    const reserved = this.store.update<{ prior?: Filing }>((all) => {
      const prior = all.find((f) => f.key === key);
      if (prior && prior.status !== 'simulated' && !isStalePreparing(prior, this.now())) return { result: { prior } };
      return { filings: [...all.filter((f) => f.key !== key), base], result: {} };
    });
    if (reserved.prior) return this.reopen(reserved.prior, evidence);

    let filing: Filing;
    let aliases: Record<string, string>;
    try {
      const preset = await this.assertCanFile();
      aliases = this.aliases(evidence, preset);
      const stored = await this.storage.put(canonicalJson({ type: 'agent-on-trial/dispute-v1', openedAt, ...evidence }), { name: 'dispute.json' });
      const delivered = await this.readDelivered(evidence);
      filing = { ...base, evidence: { uri: stored.uri, hash: stored.hash, gatewayUrl: stored.gatewayUrl } };
      // Step 2 before step 1: the evidence period starts when the dispute exists.
      if (this.config.pin) filing.attachment = await this.pin(evidence, delivered);
      filing.document = jurorDocument(evidence, delivered, Boolean(filing.attachment?.fileURI));
    } catch (err) {
      this.store.releaseIfHeld(key, holder); // nothing was sent
      throw err;
    }

    if (!this.store.saveIfHeld({ ...filing, status: 'filing', updatedAt: this.stamp() })) {
      throw new Error(`another process took over the Kleros filing for receipt ${base.receiptTxHash} while this one was preparing; not filing twice`);
    }
    let created;
    try {
      this.log.info(`filing a Kleros dispute on ${chain} (aliases ${Object.keys(aliases).join(', ') || 'none'})`);
      created = await this.service.disputeCreate(aliases);
    } catch (err) {
      if (err instanceof ToolError && err.outcome !== 'not-sent') {
        const f: Filing = { ...filing, status: err.outcome === 'reverted' ? 'reverted' : 'unknown', createTx: err.txHash, error: err.text.slice(0, 1_000), updatedAt: this.stamp() };
        this.settle(f);
        throw new Error(this.unresolved(f));
      }
      this.store.releaseIfHeld(key, holder); // refused before anything was sent: nothing filed, nothing paid
      throw err;
    }

    if (created.status === 'simulated') {
      const f: Filing = { ...filing, status: 'simulated', disputeId: `simulated-${filing.evidence!.hash.slice(2, 14)}`, submission: { status: 'skipped' }, updatedAt: this.stamp() };
      this.log.warn('dispute_create simulated: the fee was quoted and the call simulated, nothing was sent and no dispute exists');
      return this.opened(this.settle(f));
    }
    if (created.status === 'unknown' || !created.coreDisputeID) {
      const f: Filing = { ...filing, status: 'unknown', createTx: created.txHash, error: created.status === 'mined' ? 'mined without a coreDisputeID' : 'broadcast, no receipt yet', updatedAt: this.stamp() };
      this.settle(f);
      throw new Error(this.unresolved(f));
    }

    // The service's word on where it filed beats our setting: reads must go there.
    const named = created.chain;
    const filedOn = isKlerosChain(named) ? named : chain;
    if (named && !isKlerosChain(named)) this.log.warn(`the service filed on "${named}", which this adapter does not know; reads of dispute ${created.coreDisputeID} are refused until a human checks`);
    else if (filedOn !== chain) this.log.warn(`the service filed on ${filedOn}, not KLEROS_CHAIN=${chain}; this dispute is read on ${filedOn}`);
    const f: Filing = {
      ...filing,
      status: 'mined',
      chain: filedOn,
      chainUnconfirmed: named && !isKlerosChain(named) ? named : undefined,
      disputeId: created.coreDisputeID,
      coreDisputeID: created.coreDisputeID,
      localDisputeID: created.localDisputeID,
      localDisputeIDUnavailable: created.localDisputeIDUnavailable,
      createTx: created.txHash,
      updatedAt: this.stamp(),
    };
    const settled = this.settle(f);
    this.log.info(`Kleros dispute ${f.coreDisputeID} filed on ${filedOn}${f.localDisputeID ? ` (arbitrable id ${f.localDisputeID})` : ''}: ${this.caseUrl(f.coreDisputeID!, filedOn)}`);
    await this.submit(settled);
    return this.opened(settled);
  }

  /**
   * Records what came of a send. If another process took the reservation over
   * meanwhile, the record goes under a key of its own: a paid dispute is never dropped.
   */
  private settle(f: Filing): Filing {
    if (this.store.saveIfHeld(f)) return f;
    const own = { ...f, key: `${f.key}#${f.holder}` };
    this.log.warn(`another process took over receipt ${f.receiptTxHash} while this one was filing; this outcome is kept as ${own.key} in ${this.store.path} for a human`);
    this.store.save(own);
    return own;
  }

  /** A receipt already on record. A mined filing is returned (finishing its evidence if that never went); anything else stops. */
  private async reopen(prior: Filing, evidence: DisputeEvidence): Promise<Opened> {
    if (prior.status !== 'mined') throw new Error(this.unresolved(prior));
    this.log.warn(`Kleros dispute ${prior.coreDisputeID} was already filed for receipt ${evidence.receipt.txHash}; returning it instead of paying a second fee`);
    if (!prior.submission || prior.submission.status === 'failed') {
      if (!prior.document) prior.document = jurorDocument(evidence, await this.readDelivered(evidence), Boolean(prior.attachment?.fileURI));
      await this.submit(prior);
    } else if (prior.submission.status === 'submitting') {
      this.log.warn(`evidence on dispute ${prior.coreDisputeID} may or may not have been submitted (a run stopped mid-submission); check the Court before submitting again`);
    }
    return this.opened(prior);
  }

  /**
   * A filing left unknown (or filing) that a human has matched to its dispute,
   * on the Court or on Arbiscan. It becomes mined, so its ruling can be read and written.
   */
  resolveFiling(receiptTxHash: string, coreDisputeID: string, localDisputeID?: string): Filing {
    if (!/^\d+$/.test(coreDisputeID)) throw new Error(`--core ${coreDisputeID} is not a Core dispute id`);
    const key = this.keyOf(receiptTxHash);
    return this.store.update<Filing>((all) => {
      const f = all.find((x) => x.key === key);
      if (!f) throw new Error(`no filing for receipt ${receiptTxHash} on ${this.config.chain} via ${this.config.service} in ${this.store.path}`);
      if (f.status !== 'unknown' && f.status !== 'filing') throw new Error(`the filing for receipt ${receiptTxHash} is ${f.status}; only unknown or filing records are resolved this way`);
      // Another real dispute's id is accepted by the service and wrong: one we already hold is certainly not this one.
      const taken = all.find((x) => x.key !== key && x.service === f.service && x.chain === f.chain && x.coreDisputeID === coreDisputeID);
      if (taken) throw new Error(`dispute ${coreDisputeID} on ${f.chain} is already the filing for receipt ${taken.receiptTxHash}; find this receipt's own dispute from its creation transaction on Arbiscan`);
      const done: Filing = { ...f, status: 'mined', disputeId: coreDisputeID, coreDisputeID, localDisputeID, error: `resolved by hand: ${f.error ?? ''}`.trim(), updatedAt: this.stamp() };
      return { filings: [...all.filter((x) => x.key !== key), done], result: done };
    });
  }

  async status(disputeId: string, opts: { ref?: string } = {}): Promise<DisputeStatus> {
    const f = this.findFiling(disputeId, opts.ref);
    if (f && f.status !== 'mined') return 'closed';
    if (f?.chainUnconfirmed) throw new Error(this.unconfirmed(f));
    const core = f?.coreDisputeID ?? (/^\d+$/.test(disputeId) ? disputeId : undefined);
    if (!core) return 'closed';
    const row = await this.service.disputeGet(core, f?.chain ?? this.config.chain);
    if (f && f.period !== row.status) this.store.save({ ...f, period: row.status, updatedAt: this.stamp() });
    if (this.config.waitFor === 'vote' && voteOver(row, this.now())) return 'ruled';
    return periodStatus(row.status, this.config.waitFor);
  }

  /**
   * dispute_get reads the arbitrator live, so the current majority is readable
   * before the dispute resolves. `tied` is what makes ruling "0" readable: no
   * majority yet, or (once the vote is over) a tie that finalises as refused.
   * A failed read is retried until waitMs runs out, then thrown.
   */
  async ruling(disputeId: string, opts: { waitMs?: number; ref?: string } = {}): Promise<Ruling | null> {
    const f = this.findFiling(disputeId, opts.ref);
    if (f && f.status === 'simulated') return null;
    if (f && f.status !== 'mined') throw new Error(this.unresolved(f));
    if (f?.chainUnconfirmed) throw new Error(this.unconfirmed(f));
    const core = f?.coreDisputeID ?? (/^\d+$/.test(disputeId) ? disputeId : undefined);
    if (!core) throw new Error(`unknown dispute ${disputeId}`);
    const chain = f?.chain ?? this.config.chain;
    if (f?.ruling?.final && f.ruling.map === rulingMapString(this.config.rulingMap)) return f.ruling.ruling;
    const waitMs = Number.isFinite(opts.waitMs) ? Math.max(0, opts.waitMs!) : 0;
    const until = this.now() + waitMs;
    for (;;) {
      let row: DisputeRow | undefined;
      let failed: unknown;
      try {
        row = await this.service.disputeGet(core, chain);
      } catch (err) {
        failed = err;
        this.opsWarn(`dispute_get ${core} on ${chain} failed: ${(err as Error).message.split('\n')[0]}`);
      }
      if (row && this.decided(row)) {
        // Degraded reads are common on the Testnet: a row without its answers cannot confirm the pinned titles yet.
        if (!this.answersMissing(core, chain, row)) return this.toRuling(disputeId, core, chain, row, f);
        failed = new Error(this.missingAnswers(core, chain, row));
        this.opsWarn((failed as Error).message);
      }
      const left = until - this.now();
      if (left <= 0) {
        if (failed) throw failed;
        if (f && row && f.period !== row.status) this.store.save({ ...f, period: row.status, updatedAt: this.stamp() });
        return null;
      }
      await this.sleep(Math.min(this.config.pollMs, left));
    }
  }

  /** A read that is retried, here or by the next poll, is the operator's business, not the room's. */
  private opsWarn(text: string) {
    if (this.log.opsWarn) this.log.opsWarn(text);
    else this.log.warn(text);
  }

  async health() {
    const c = this.config;
    if (!c.apiKey) return { ok: false, detail: `${c.keyVar} unset: request a ${c.chain} key at https://ai.kleros.io` };
    if (c.chain === 'arbitrum-one' && !c.allowBeta) return { ok: false, detail: BETA };
    const where = `${c.chain} via ${c.service}`;
    try {
      const p = await this.preset();
      if (!p.canFile) return { ok: false, detail: `${where}: this key reads only (dispute_create is not in its tools/list, so it has no Preset)` };
      if (!p.instructions) return { ok: false, detail: `${where}: no instructions from the service (${p.instructionsError ?? 'empty'}), so the Preset's chain cannot be checked` };
      if (p.chain && p.chain !== c.chain) return { ok: false, detail: `${where}: the key's instructions name ${p.chain}; the key decides where disputes are filed` };
      const trusted = !p.chain && c.trustPreset === p.fingerprint;
      const betaUnsure = !p.chain && mentionsBeta(p.instructions) && !c.allowBeta;
      const slots = this.slotNames(p);
      const parties = [slots.complainant && `complainant→"${slots.complainant}"`, slots.respondent && `respondent→"${slots.respondent}"`].filter(Boolean).join(' ');
      const mode = p.mode === 'simulate' ? 'simulates' : p.mode === 'broadcast' ? 'broadcasts' : 'broadcast or simulate: see check:kleros';
      const notes = [
        !p.chain && (trusted ? 'chain trusted (instructions read)' : `instructions do not name one chain: read them (pnpm check:kleros), then set KLEROS_TRUST_PRESET=${p.fingerprint}`),
        betaUnsure && BETA_UNSURE,
        !c.rulingMap && NO_MAP,
      ].filter(Boolean);
      return {
        ok: (Boolean(p.chain) || trusted) && !betaUnsure && Boolean(c.rulingMap),
        detail: `${where}${p.filing ? ` · court ${p.filing.court}, ${p.filing.jurors} juror${p.filing.jurors === 1 ? '' : 's'}` : ''} · ${mode} · slots ${p.slots.length ? p.slots.join(', ') : 'not in the schema'} · ${parties || 'no parties named (set KLEROS_ALIAS_*)'} · rulings ${rulingMapString(c.rulingMap)}${notes.length ? ` · ${notes.join(' · ')}` : ''}`,
      };
    } catch (err) {
      return { ok: false, detail: `${where}: ${(err as Error).message.split('\n')[0]}` };
    }
  }

  /** Read fresh before every filing: a fee is worth two reads, and a Preset can change. */
  private async assertCanFile(): Promise<PresetInfo> {
    const c = this.config;
    if (!c.apiKey) throw new Error(`${c.keyVar} unset: no Kleros dispute can be filed (request a ${c.chain} key at https://ai.kleros.io)`);
    if (c.chain === 'arbitrum-one' && !c.allowBeta) throw new Error(BETA);
    const p = await this.preset(true);
    if (!p.canFile) throw new Error('this Kleros key has no Preset: dispute_create is not in its tools/list');
    if (!p.instructions) throw new Error(`no instructions from the Kleros service (${p.instructionsError ?? 'empty'}): the Preset's chain and mode cannot be checked, so nothing is filed`);
    if (p.chain && p.chain !== c.chain) throw new Error(`this Kleros key files on ${p.chain} but KLEROS_CHAIN=${c.chain}; the key, not the setting, decides where the dispute goes`);
    if (!p.chain && c.trustPreset !== p.fingerprint) {
      throw new Error(
        `the Kleros instructions for this key do not name one chain. Read them (pnpm check:kleros); if this key files on KLEROS_CHAIN=${c.chain}, set KLEROS_TRUST_PRESET=${p.fingerprint}` +
          (c.trustPreset ? ` (it is ${c.trustPreset}: the instructions changed since they were read)` : ''),
      );
    }
    if (!p.chain && mentionsBeta(p.instructions) && !c.allowBeta) throw new Error(BETA_UNSURE);
    return p;
  }

  /** KLEROS_ALIAS_* when set, else buyer and provider where the Preset's schema lists them. */
  slotNames(preset: PresetInfo): { complainant?: string; respondent?: string } {
    const pick = (set: string | undefined, fallback: string) => set ?? (preset.slots.includes(fallback) ? fallback : undefined);
    return { complainant: pick(this.config.slots.complainant, DEFAULT_SLOTS.complainant), respondent: pick(this.config.slots.respondent, DEFAULT_SLOTS.respondent) };
  }

  /** Parties we know, by the Preset's own slot names. An unknown party (the zero address, a precompile) is left out, not sent as a placeholder. */
  private aliases(evidence: DisputeEvidence, preset: PresetInfo): Record<string, string> {
    const out: Record<string, string> = {};
    const slots = this.slotNames(preset);
    const put = (slot: string | undefined, address: string | undefined, envVar: string) => {
      if (!slot) return;
      if (preset.slots.length && !preset.slots.includes(slot)) {
        throw new Error(`${envVar}="${slot}" is not one of this Preset's alias slots: ${preset.slots.join(', ')}`);
      }
      if (address && /^0x[0-9a-fA-F]{40}$/.test(address) && !isPlaceholderAddress(address)) out[slot] = getAddress(address);
    };
    put(slots.complainant, evidence.complainant.address, 'KLEROS_ALIAS_COMPLAINANT');
    put(slots.respondent, evidence.respondent.address, 'KLEROS_ALIAS_RESPONDENT');
    return out;
  }

  /** Step 2. Safe to retry (same bytes, same CID), so a failure only costs the jurors the attachment. */
  private async pin(evidence: DisputeEvidence, delivered: Delivered): Promise<Filing['attachment']> {
    try {
      const pin = await this.service.evidencePin(new TextEncoder().encode(canonicalJson(jurorAttachment(evidence, delivered))), 'json');
      if (pin.status === 'checked') this.log.warn('evidence_pin only checked the attachment (this Preset does not publish); the jurors read the description alone');
      else this.log.info(`juror attachment published ${pin.fileURI}`);
      return { status: pin.status, fileURI: pin.fileURI, cid: pin.cid };
    } catch (err) {
      this.log.warn(`evidence_pin failed, filing without an attachment: ${(err as Error).message.split('\n')[0]}`);
      return undefined;
    }
  }

  /** Step 3 against the Core id, with the document built at filing time. A failure is recorded and warned, not thrown: the dispute exists. */
  private async submit(f: Filing): Promise<void> {
    const attached = f.attachment?.fileURI;
    const doc = f.document!;
    f.submission = { status: 'submitting' };
    this.store.save({ ...f, updatedAt: this.stamp() });
    try {
      const out = await this.service.evidenceSubmit({ dispute: f.coreDisputeID!, name: doc.name, description: doc.description, fileUri: attached, fileTypeExtension: attached ? 'json' : undefined });
      if (out.status === 'unknown') this.log.warn(`evidence_submit broadcast with no receipt yet (tx ${out.txHash}); it is probably recorded, do not submit again`);
      else if (out.status === 'simulated') this.log.warn('evidence_submit simulated: nothing was recorded');
      else this.log.info(`evidence recorded on dispute ${f.coreDisputeID}${out.txHash ? ` (tx ${out.txHash})` : ''}`);
      f.submission = { status: out.status, txHash: out.txHash };
    } catch (err) {
      const outcome = err instanceof ToolError ? err.outcome : 'not-sent';
      const msg = (err as Error).message.split('\n')[0];
      const advice =
        outcome === 'not-sent'
          ? 'nothing was sent; opening the dispute again for this receipt retries it, before the evidence period closes'
          : outcome === 'reverted'
            ? 'the transaction reverted and nothing was recorded; a human reads why before submitting again'
            : 'it may have been sent; do not submit again, check the transaction with a human';
      this.log.warn(`evidence_submit on dispute ${f.coreDisputeID} failed: ${msg}. The dispute exists; ${advice}`);
      f.submission = { status: outcome === 'not-sent' ? 'failed' : outcome === 'reverted' ? 'reverted' : 'unknown', txHash: err instanceof ToolError ? err.txHash : undefined, error: msg };
    }
    this.store.save({ ...f, updatedAt: this.stamp() });
  }

  /** The ruling is final for us once the vote is over: an appeal is not waited for, and a tie then is a refusal. */
  private decided(row: DisputeRow): boolean {
    if (row.ruling === null || row.ruling === undefined) return false; // unresolved, not "refused"
    if (this.config.waitFor === 'executed') return row.status === 'Executed';
    return voteOver(row, this.now());
  }

  private answersMissing(core: string, chain: KlerosChain, row: DisputeRow): boolean {
    const pinned = [...(this.config.rulingMap?.values() ?? [])].some((m) => m.title);
    return pinned && !this.config.confirmedAnswers.has(`${chain}:${core}`) && !(row.rulingOptions ?? []).some((o) => Number(o.value) !== 0);
  }

  private missingAnswers(core: string, chain: KlerosChain, row: DisputeRow): string {
    const why = row.unresolvedFields?.length ? `${row.unresolvedFields.join(', ')} unresolved: ${row.unresolvedReason ?? 'no reason given'}` : (row.unresolvedReason ?? 'unresolved');
    return `dispute ${core} on ${chain} came back without its answers (${why}), so the titles in KLEROS_RULING_MAP cannot be confirmed. The service says such reads are normal on the Testnet and may not clear: check the answers on ${this.caseUrl(core, chain)}, then set KLEROS_CONFIRMED_ANSWERS=${chain}:${core}`;
  }

  /** Every answer on the dispute must be mapped, and pinned titles must match, before a ruling is read as a winner. */
  private checkAnswers(core: string, chain: KlerosChain, row: DisputeRow): RulingMap {
    const map = this.config.rulingMap;
    if (!map) throw new Error(NO_MAP);
    const options = (row.rulingOptions ?? []).filter((o) => Number(o.value) !== 0);
    const pinned = [...map.values()].some((m) => m.title);
    if (!options.length) {
      if (pinned && !this.config.confirmedAnswers.has(`${chain}:${core}`)) throw new Error(this.missingAnswers(core, chain, row));
      if (pinned) {
        this.log.warn(`dispute ${core} carries no ruling options (${row.unresolvedReason ?? 'unresolved'}); reading it with KLEROS_RULING_MAP, as confirmed by hand (KLEROS_CONFIRMED_ANSWERS)`);
        return map;
      }
      this.log.warn(`dispute ${core} carries no ruling options (${row.unresolvedReason ?? 'unresolved'}); reading its ruling with KLEROS_RULING_MAP unconfirmed`);
      return map;
    }
    const problems: string[] = [];
    for (const o of options) {
      const m = map.get(Number(o.value));
      if (!m) problems.push(`${o.value} "${o.title}" is not mapped`);
      else if (m.title && m.title.toLowerCase() !== o.title.trim().toLowerCase()) problems.push(`${o.value} is "${o.title}", the map expects "${m.title}"`);
    }
    if (problems.length) {
      throw new Error(`KLEROS_RULING_MAP=${rulingMapString(map)} does not match dispute ${core}'s answers: ${problems.join('; ')}. Read them with pnpm check:kleros --dispute ${core}`);
    }
    return map;
  }

  private async toRuling(disputeId: string, core: string, chain: KlerosChain, row: DisputeRow, f?: Filing): Promise<Ruling> {
    const map = this.checkAnswers(core, chain, row);
    const mapString = rulingMapString(map);
    const value = Number(row.ruling ?? 0);
    const tied = row.tied === true;
    const final = this.config.waitFor === 'vote' || row.status === 'Executed'; // decided means settled: never read again
    const rounds = row.roundCount ?? 1;
    const cached = f?.ruling;
    if (cached && cached.period === row.status && cached.value === value && cached.tied === tied && cached.round === rounds && cached.map === mapString) return cached.ruling;

    const label = row.rulingOptions?.find((o) => Number(o.value) === value)?.title ?? row.rulingLabel ?? undefined;
    if (!tied && value !== 0 && !map.has(value)) {
      throw new Error(`Kleros ruled ${value}${label ? ` ("${label}")` : ''} on dispute ${core}, which KLEROS_RULING_MAP=${mapString} does not map; read the answers with pnpm check:kleros --dispute ${core}`);
    }
    const winner: Ruling['winner'] = tied || value === 0 ? 'refused' : map.get(value)!.winner;
    const stage = row.status === 'Executed' ? 'executed' : rounds > 1 ? `the vote of round ${rounds} is over, after an appeal` : 'the vote is over';
    const where = `Court ${row.court ?? '?'} on ${chain}.`;
    const overridden = row.overridden ? ' Overridden on appeal.' : '';
    const rationale = tied
      ? `The Kleros jurors did not reach a majority (tied vote, ${stage}); a tie counts as refuse to arbitrate. ${where}${overridden}`
      : value === 0
        ? `The Kleros jurors refused to arbitrate (${stage}). ${where}${overridden}`
        : `The Kleros jurors ruled ${value}${label ? ` "${label}"` : ''} (${stage}). ${where}${overridden}`;
    const ruledAt = row.lastPeriodChange ?? new Date(this.now()).toISOString();
    const caseUrl = this.caseUrl(core, chain);
    const doc = {
      type: 'agent-on-trial/ruling-v1',
      disputeId,
      winner,
      rationale,
      ruledAt,
      kleros: {
        chain,
        court: row.court,
        coreDisputeID: core,
        localDisputeID: f?.localDisputeID,
        period: row.status,
        final,
        ruling: value,
        rulingLabel: label,
        tied,
        roundCount: row.roundCount,
        overridden: row.overridden,
        rulingOptions: row.rulingOptions ?? undefined,
        rulingMap: mapString,
        caseUrl,
        createTx: f?.createTx,
      },
    };
    const ref = await this.storage.put(canonicalJson(doc), { name: 'ruling.json' });
    const ruling: Ruling = { winner, rationale, ruledAt, ref, externalId: core, proofUrl: caseUrl };
    if (f) this.store.save({ ...f, period: row.status, updatedAt: this.stamp(), ruling: { period: row.status, value, tied, final, round: rounds, map: mapString, ruling } });
    return ruling;
  }

  private opened(f: Filing): Opened {
    const detail: Record<string, unknown> = { kleros: f.chain, filing: f.key };
    if (f.status === 'simulated') detail.simulated = true;
    if (f.coreDisputeID) detail.coreDisputeID = f.coreDisputeID;
    if (f.localDisputeID) detail.localDisputeID = f.localDisputeID;
    if (f.localDisputeIDUnavailable) detail.localDisputeIDUnavailable = f.localDisputeIDUnavailable;
    if (f.createTx) detail.createTx = this.txUrl(f.createTx, f.chain);
    if (f.attachment?.fileURI) detail.attachment = f.attachment.fileURI;
    if (f.submission) detail.evidenceSubmitted = f.submission.status;
    if (f.submission?.txHash) detail.evidenceTx = this.txUrl(f.submission.txHash, f.chain);
    return {
      disputeId: f.disputeId!,
      uri: f.evidence!.uri,
      gatewayUrl: f.evidence!.gatewayUrl,
      url: f.coreDisputeID ? this.caseUrl(f.coreDisputeID, f.chain) : undefined,
      detail,
    };
  }

  private unresolved(f: Filing): string {
    const where = `receipt ${f.receiptTxHash} on ${f.chain}`;
    const tx = f.createTx ? ` (tx ${this.txUrl(f.createTx, f.chain)})` : '';
    const why = f.error ? `: ${f.error.split('\n')[0].slice(0, 300)}` : '';
    if (f.status === 'preparing') return `another process (pid ${f.pid}) is preparing a Kleros filing for ${where} since ${f.updatedAt}; not filing twice`;
    if (f.status === 'reverted') {
      return `the Kleros filing for ${where} was mined and reverted${tx}${why}. No dispute exists and the fee came back, but the gas is spent. Not filing again blind: a human reads why, then removes the record for ${where} from ${this.store.path}`;
    }
    return (
      `a Kleros filing for ${where} may already exist${tx}${why}. Not filing again: a second filing pays a second fee. ` +
      `A human finds it in the Court or on Arbiscan, then: pnpm check:kleros --resolve ${f.receiptTxHash} --core <id> (or removes the record from ${this.store.path} if nothing was filed)`
    );
  }

  private unconfirmed(f: Filing): string {
    return `the service filed dispute ${f.coreDisputeID} on "${f.chainUnconfirmed}", a chain this adapter does not know; check it in the Court, then set "chain" and remove "chainUnconfirmed" for receipt ${f.receiptTxHash} in ${this.store.path}`;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private async readDelivered(evidence: DisputeEvidence): Promise<Delivered> {
    try {
      return { text: new TextDecoder().decode(await this.storage.get(evidence.delivered.uri)) };
    } catch (err) {
      this.log.warn(`could not read the delivered body back from storage (${(err as Error).message.split('\n')[0]}); the jurors get its hash only`);
      return {};
    }
  }
}

/**
 * The alias slots. The schema may list them as properties, or take any string
 * key and name them in its description ("Available slots: buyer, provider."),
 * as the instructions do ("keyed by slot: buyer, provider.").
 */
export function presetSlots(aliases: { properties?: Record<string, unknown>; description?: string } | undefined, instructions?: string): string[] {
  const listed = Object.keys(aliases?.properties ?? {});
  if (listed.length) return listed;
  const named = (text: string | undefined, re: RegExp) => {
    const m = text?.match(re);
    if (!m) return [];
    return m[1]
      .split(/,|\band\b/)
      .map((x) => x.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, ''))
      .filter((x) => /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(x));
  };
  const fromSchema = named(aliases?.description, /available slots?\s*:\s*([^.\n]+)/i);
  return fromSchema.length ? fromSchema : named(instructions, /keyed by slots?\s*:\s*([^.\n]+)/i);
}

/** Instructions that mention Beta without saying which chain this key files on. */
function mentionsBeta(instructions?: string): boolean {
  return BETA_WORDS.test(instructions ?? '');
}

/** With KLEROS_WAIT_FOR=executed the Appeal period is not yet a ruling. */
export function periodStatus(period: string, waitFor: KlerosConfig['waitFor'] = 'vote'): DisputeStatus {
  if (period === 'Evidence') return 'evidence';
  if (period === 'Executed' || (period === 'Appeal' && waitFor === 'vote')) return 'ruled';
  return 'open';
}

/**
 * The vote is over: the Appeal period, execution, or the whole panel's vote is in. A panel of one has
 * voted once its juror's vote is revealed (tied false in the Vote period), deadline or not: nothing can
 * change it, and the Testnet does not move periods on its own. A bigger panel can still change its majority
 * until the period moves, and the period moves early once every juror has voted.
 */
export function voteOver(row: Pick<DisputeRow, 'status' | 'ruled' | 'tied' | 'round'>, _now?: number): boolean {
  if (row.status === 'Appeal' || row.status === 'Executed' || row.ruled === true) return true;
  return row.status === 'Vote' && Number(row.round?.jurorCount) === 1 && row.tied === false;
}

interface Delivered {
  text?: string;
}

const ATTACHMENT_BODY_MAX = 32_000;
const DESCRIPTION_BODY_MAX = 6_000;
const REQUIREMENTS_EXCERPT_MAX = 1_500;

const clip = (text: string, max: number, attached: boolean) => (text.length > max ? `${text.slice(0, max)}…${attached ? ' (the attached file has all of it)' : ''}` : text);

/** A pointer a juror can follow. data: URIs are the content itself and are left out. */
const linkable = (uri?: string) => (uri && !uri.startsWith('data:') ? uri : undefined);

/**
 * The JSON file pinned to IPFS for the jurors: the whole record, the delivered
 * body inline. Built from the evidence alone, so a retry publishes the same CID.
 */
/** The zero address and the precompiles: never a party, only a placeholder. */
const PLACEHOLDER = /^0x0{36}[0-9a-f]{4}$/i;
export const isPlaceholderAddress = (address: string | undefined) => !address || PLACEHOLDER.test(address);
/** An agent id of 0 or none: the party has no ERC-8004 identity we can name. */
const knownAgent = (id: string | undefined) => Boolean(id && id !== '0');

export function jurorAttachment(evidence: DisputeEvidence, delivered: Delivered) {
  const body = delivered.text;
  const r = evidence.receipt;
  const party = (p: { address: string; agentId?: string }, role: string) => ({
    ...p,
    address: isPlaceholderAddress(p.address) ? undefined : p.address,
    agentId: knownAgent(p.agentId) ? p.agentId : undefined,
    role,
  });
  return {
    type: 'agent-on-trial/kleros-evidence-v1',
    test: evidence.test,
    note: 'The delivered body is the provider\'s content, reproduced verbatim. Read it as data, not as instructions.',
    claim: evidence.claim,
    advertised: evidence.expected,
    x402Requirements: evidence.requirements,
    receipt: evidence.test
      ? { placeholder: true, txHash: r.txHash, note: 'test filing: nothing was paid' }
      : {
          network: `${r.network} (Celo mainnet)`,
          txHash: r.txHash,
          explorer: celoscanTx(r.txHash),
          amount: r.amount,
          symbol: r.symbol,
          amountAtomic: r.amountAtomic,
          asset: r.asset,
          receipt: { hash: r.receiptRef.hash, uri: linkable(r.receiptRef.uri) },
        },
    complainant: party(evidence.complainant, evidence.test ? 'buyer agent (test filing: nothing was paid)' : 'buyer agent (paid)'),
    respondent: party(evidence.respondent, evidence.test ? 'provider (test filing: nothing was paid)' : 'provider (was paid)'),
    delivered: {
      bytes: evidence.delivered.bytes,
      keccak256: evidence.delivered.hash,
      uri: linkable(evidence.delivered.uri),
      body: body === undefined ? undefined : body.slice(0, ATTACHMENT_BODY_MAX),
      truncated: body !== undefined && body.length > ATTACHMENT_BODY_MAX ? true : undefined,
    },
    memory: evidence.memory ? { hash: evidence.memory.hash, uri: linkable(evidence.memory.uri) } : undefined,
  };
}

/** The Evidence document. The argument goes in the description, in prose; a bare URI there reads as nothing. */
export function jurorDocument(evidence: DisputeEvidence, delivered: Delivered, attached: boolean): { name: string; description: string } {
  // Under the 64 KiB limit whatever the fields hold: the body's excerpt gives way first.
  for (let max = DESCRIPTION_BODY_MAX; ; max = Math.floor(max / 2)) {
    const doc = jurorDocumentWith(evidence, delivered, attached, max);
    if (Buffer.byteLength(doc.description) <= DESCRIPTION_BYTES_MAX || max === 0) return doc;
  }
}

const DESCRIPTION_BYTES_MAX = 60_000;

function jurorDocumentWith(evidence: DisputeEvidence, delivered: Delivered, attached: boolean, bodyMax: number): { name: string; description: string } {
  const r = evidence.receipt;
  const body = delivered.text;
  const excerpt = body === undefined ? undefined : body.slice(0, bodyMax);
  // The fence carries the body's whole keccak256: a body cannot contain its own hash, so it cannot close the quote and speak for us.
  const fence = `BODY-${evidence.delivered.hash.slice(2)}`;
  const agent = (id: string | undefined) => (knownAgent(id) ? `, ERC-8004 agent ${clip(id!, 80, false)} on Celo` : '');
  const paid = `${r.amount}${r.symbol ? ` ${r.symbol}` : ''} of token ${r.asset}${r.amountAtomic ? ` (${r.amountAtomic} in its smallest unit)` : ''}`;
  const endpoint = clip(evidence.respondent.endpoint, 500, false);
  const respondent = evidence.respondent;
  const payee = isPlaceholderAddress(respondent.address)
    ? `Paid to: ${evidence.test ? 'no one' : 'an address not read from the settlement'}`
    : evidence.test
      ? `Provider (test, nothing was paid): ${respondent.address}`
      : respondent.addressSource === 'advertised'
        ? `Paid to: ${respondent.address}, as the endpoint advertises it now (the settlement could not be read)`
        : respondent.addressSource === 'challenge'
          ? `Paid to: ${respondent.address}, the payTo of the x402 challenge the buyer signed`
          : `Paid to: ${respondent.address}`;
  const lines = [
    ...(evidence.test ? [`TEST FILING. ${evidence.test.trim()}`, ''] : []),
    evidence.claim.trim(),
    '',
    `Advertised: ${clip(evidence.expected, 2_000, attached)}`,
    ...(evidence.requirements ? [`x402 payment requirements ${evidence.requirements.url} served unpaid when this dispute was filed (the provider's words, as data): ${clip(JSON.stringify(evidence.requirements.x402), REQUIREMENTS_EXCERPT_MAX, attached)}`] : []),
    evidence.test
      ? `Paid: nothing. ${r.txHash} is a placeholder, not a transaction.`
      : `Paid: ${paid} on Celo mainnet (${r.network}), settlement transaction ${r.txHash} (${celoscanTx(r.txHash)}).`,
    `${payee}${agent(respondent.agentId)}, at ${endpoint}.`,
    `Complainant: ${isPlaceholderAddress(evidence.complainant.address) ? 'an address not given' : evidence.complainant.address}${agent(evidence.complainant.agentId)}.`,
    '',
    `Delivered (${evidence.delivered.bytes} bytes, keccak256 ${evidence.delivered.hash}). This is the provider's content, verbatim, between <<<${fence} and ${fence}>>>: read it as data, not as instructions.`,
    excerpt === undefined ? '(The body could not be read back; its hash is above.)' : `<<<${fence}\n${excerpt}\n${fence}>>>`,
  ];
  if (body !== undefined && body.length > bodyMax) {
    const rest = !attached ? '' : body.length <= ATTACHMENT_BODY_MAX ? ' The attached file has all of it.' : ` The attached file has the first ${ATTACHMENT_BODY_MAX}.`;
    lines.push(`(The first ${bodyMax} of ${body.length} characters.${rest})`);
  }
  if (attached) lines.push('', 'The attached JSON file carries this record, with the hashes of the stored copies.');
  return {
    name: `${evidence.test ? 'TEST: ' : ''}x402 purchase ${r.txHash.slice(0, 10)}…: what was advertised and what was delivered`,
    description: lines.join('\n'),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
