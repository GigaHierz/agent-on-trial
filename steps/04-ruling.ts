import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { CHAIN_ID } from '@trial/shared';
import type { ActContext } from '../agent/context.js';
import { getDispute, makeDispute, type DisputeAdapter } from '../adapters/dispute/index.js';
import { KlerosDispute, isPlaceholderAddress } from '../adapters/dispute/kleros.js';
import { getStorage } from '../adapters/storage/index.js';
import { RUN_DIR, env, hasRole, roleAddress } from '../lib/env.js';
import { sameEndpoint } from '../agent/tools/dispute.js';
import { SHADY_REPORT_URL } from '../shady-provider/gate.js';
import { log } from '../lib/log.js';
import { recordRuling, rulingWritten, say, type PendingRuling } from './04-dispute.js';
import { asScript, isMain } from './run.js';

/**
 * pnpm act:ruling [--wait <ms>] [--dispute <id>]       (/act ruling in the session)
 *
 * Finishes act 4 when the ruling comes after the act. A Kleros dispute takes
 * twenty minutes to over an hour to finish its vote, and the act
 * waits 30 s. This reads the latest "Ruling pending" exhibit, asks the adapter
 * it was opened with (once, or until --wait runs out) and writes the ruling on
 * both parties from the arbitrator key, exactly as act 4 would have. A half
 * already on chain is never written again (.runs/rulings.json).
 *
 * --dispute <id> with no pending exhibit (the act died after filing) rebuilds
 * the record from the Kleros filing in KLEROS_STATE_FILE.
 */
export async function rulingAct(ctx: ActContext, opts: { waitMs?: number; disputeId?: string } = {}) {
  if (env.fixture) {
    log.warn('--fixture: the recorded dispute is not ruled live');
    return;
  }
  const release = holdWatcher();
  if (!release) return;
  try {
    await readAndRecord(ctx, opts);
  } finally {
    release();
  }
}

const WATCHER = `${RUN_DIR}/ruling-watcher.pid`;

/**
 * One ruling reader at a time on this machine: two would both sign from the relay key at once. A second one
 * says who holds it and stops; a holder that died is taken over.
 */
function holdWatcher(): (() => void) | null {
  mkdirSync(RUN_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(WATCHER, String(process.pid), { flag: 'wx' });
      return () => rmSync(WATCHER, { force: true });
    } catch {
      const holder = Number(readFileSync(WATCHER, 'utf8').trim());
      if (holder && holder !== process.pid && alive(holder)) {
        log.warn(`a ruling reader is already running (pid ${holder}); it writes the ruling when it comes. Stop it first to read here`);
        return null;
      }
      rmSync(WATCHER, { force: true }); // its process is gone
    }
  }
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readAndRecord(ctx: ActContext, opts: { waitMs?: number; disputeId?: string }) {
  ctx.evidence.reload();
  const pending = findPending(ctx, opts.disputeId) ?? (opts.disputeId ? fromFiling(opts.disputeId) : undefined);
  if (!pending) {
    log.opsWarn(opts.disputeId ? `no pending ruling for dispute ${opts.disputeId} in run ${ctx.evidence.runId}` : `no pending ruling in run ${ctx.evidence.runId}`);
    return;
  }
  const adapter: DisputeAdapter = pending.adapter === getDispute().name ? getDispute() : makeDispute(pending.adapter, getStorage());
  say(`Waiting for the jurors' ruling on dispute ${pending.disputeId}${pending.url ? `: ${pending.url}` : ''}`);
  const ruling = await adapter.ruling(pending.disputeId, { waitMs: opts.waitMs ?? 0, ref: pending.ref });
  if (!ruling) {
    say(`The jurors are still voting on dispute ${pending.disputeId}.`);
    log.ops(`dispute ${pending.disputeId} is ${await adapter.status(pending.disputeId, { ref: pending.ref })} (${adapter.name}); run again later, or with --wait <ms>`);
    return;
  }
  await recordRuling(ctx, pending, ruling);
}

/** The latest "Ruling pending" exhibit whose ruling is not fully on chain. */
function findPending(ctx: ActContext, disputeId?: string): PendingRuling | undefined {
  const exhibits = ctx.evidence.data.exhibits;
  for (let i = exhibits.length - 1; i >= 0; i--) {
    const e = exhibits[i];
    const d = e.detail as (Partial<PendingRuling> & { pending?: boolean }) | undefined;
    if (e.act !== 'dispute' || e.kind !== 'note' || d?.pending !== true || e.fixture) continue;
    if (!d.disputeId || !d.adapter || !d.agentId || !d.proof) continue;
    if (disputeId && d.disputeId !== disputeId) continue;
    if (rulingWritten(d as PendingRuling)) {
      log.info(`the ruling for dispute ${d.disputeId} is already on chain`);
      if (disputeId) return undefined;
      continue;
    }
    return d as PendingRuling;
  }
  return undefined;
}

/** A mined Kleros filing carries who paid whom: enough to write its ruling without the act's exhibit. */
function fromFiling(disputeId: string): PendingRuling | undefined {
  const kleros = getDispute() instanceof KlerosDispute ? (getDispute() as KlerosDispute) : (makeDispute('kleros', getStorage()) as KlerosDispute);
  const f = kleros.findFiling(disputeId);
  if (!f || f.status !== 'mined' || !f.parties) return undefined;
  if (f.test) {
    log.warn(`dispute ${disputeId} is a pnpm check:dispute test filing over no purchase: no feedback is written from it`);
    return undefined;
  }
  // SHADY_AGENT_ID and the shady payTo apply only to a filing about our shady endpoint, as in act 4. Another
  // provider is not ours to name: its half is left out. A filing that names another agent is a human's call.
  const r = f.parties.respondent;
  const ours = sameEndpoint(r.endpoint, SHADY_REPORT_URL);
  const filed = r.agentId;
  if (ours && env.shadyAgentId && filed && filed !== env.shadyAgentId) {
    throw new Error(`the filing for dispute ${disputeId} names provider agent ${filed}, but SHADY_AGENT_ID is ${env.shadyAgentId}; a human decides which one the ruling is about`);
  }
  const shadyPayTo = env.shadyPayTo ?? (hasRole('shady') ? roleAddress('shady') : '');
  const payTo = r.addressSource === 'advertised' ? '' : isPlaceholderAddress(r.address) ? (ours ? shadyPayTo : '') : r.address;
  const p: PendingRuling = {
    disputeId,
    adapter: 'kleros',
    ref: f.key,
    agentId: (f.parties.complainant.agentId !== '0' && f.parties.complainant.agentId) || env.agentId || '',
    shadyAgentId: ours ? env.shadyAgentId : undefined, // never the id the model typed: without SHADY_AGENT_ID the provider half is left out
    proof: { fromAddress: f.parties.complainant.address, toAddress: payTo, chainId: String(CHAIN_ID), txHash: f.receiptTxHash },
    url: f.coreDisputeID ? kleros.caseUrl(f.coreDisputeID, f.chain) : undefined,
  };
  if (!p.agentId) throw new Error(`the filing for dispute ${disputeId} names no complainant agent id; set AGENT_ID`);
  if (rulingWritten(p)) {
    log.info(`the ruling for dispute ${disputeId} is already on chain`);
    return undefined;
  }
  log.info(`no pending exhibit for dispute ${disputeId}; writing its ruling from the filing record (receipt ${f.receiptTxHash})`);
  return p;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (isMain(import.meta.url)) {
  const waitMs = Number(arg('--wait') ?? 0);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`--wait ${arg('--wait')} is not a number of milliseconds`);
  asScript('ruling', (ctx) => rulingAct(ctx, { waitMs, disputeId: arg('--dispute') }));
}
