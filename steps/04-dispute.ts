import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { CHAIN_ID, TAGS, celoscanAddress, celoscanTx } from '@trial/shared';
import { BaseError, type Hex } from 'viem';
import { lastArtifact, type ActContext } from '../agent/context.js';
import { crossExamine } from '../agent/cross.js';
import { sameEndpoint } from '../agent/tools/dispute.js';
import { runAct } from '../agent/loop.js';
import { getDispute, type Ruling } from '../adapters/dispute/index.js';
import type { StoredRef } from '../adapters/storage/types.js';
import { paidAmount } from '../lib/buy.js';
import { publicClient } from '../lib/clients.js';
import { RUN_DIR, env, hasRole, roleAddress } from '../lib/env.js';
import { replayFixture } from '../lib/evidence.js';
import { writeFeedback } from '../lib/feedback.js';
import { withFileLock } from '../lib/filelock.js';
import { log } from '../lib/log.js';
import { startShadyGate, SHADY_REPORT_URL } from '../shady-provider/gate.js';
import { asScript, isMain } from './run.js';

/**
 * Act 4: a purchase goes wrong.
 * The agent buys a "market report" from a provider with no reputation, gets
 * junk, and opens a dispute through the dispute adapter. The agent writes
 * negative feedback on the provider; the arbitrator writes the ruling on both.
 *
 * With the kleros adapter the dispute costs a fee and its ruling takes an hour,
 * so once a dispute exists the act always leaves a "Ruling pending" record that
 * pnpm act:ruling can finish from, whatever fails after it.
 */
/** The story beats on the live log, written like code comments for anyone watching. */
export const say = (text: string) => log.host(`// ${text}`);

export async function disputeAct(ctx: ActContext) {
  if (env.fixture) return replayFixture(ctx.evidence, 'dispute');
  const agentId = ctx.evidence.data.agentId ?? env.agentId;
  if (!agentId) throw new Error('no agent id; run act identity first');
  const shadyAgentId = ctx.evidence.data.shadyAgentId ?? env.shadyAgentId;
  if (!shadyAgentId) log.warn('SHADY_AGENT_ID unset: the provider has no identity, so no feedback can be written on it (pnpm shady:register)');
  const kleros = getDispute().name === 'kleros';

  const gate = await startShadyGate();
  let actError: unknown;
  try {
    ctx.params.shadyUrl = SHADY_REPORT_URL;
    ctx.params.shadyAgentId = shadyAgentId;
    // In the session, artifacts accumulate across acts: only this act's count.
    const from = ctx.artifacts.length;
    try {
      await runAct(ctx, 'dispute', null);
    } catch (err) {
      if (!kleros) throw err;
      // A filed dispute must still reach the evidence and a pending record.
      actError = err;
      log.error(`the agent's turn failed: ${(err as Error).message.split('\n')[0]}`);
    }

    const receipt = lastArtifact(ctx, 'x402_receipt', from);
    const response = lastArtifact(ctx, 'x402_response', from);
    const dispute = lastArtifact(ctx, 'dispute', from);
    const failed = lastArtifact(ctx, 'dispute_failed', from);
    const memory = lastArtifact(ctx, 'memory', from);

    if (receipt?.txHash) {
      ctx.evidence.add({
        letter: 'B',
        act: 'dispute',
        kind: 'tx',
        title: `Paid ${paidAmount(receipt.amount, receipt.asset).label} through x402 to the shady provider`,
        txHash: receipt.txHash,
        detail: { url: receipt.url, payTo: receipt.raw.payTo ?? gate.payTo },
      });
    } else {
      log.warn('the shady purchase did not settle');
    }
    // A simulating Kleros Preset files nothing: no dispute exists, so nothing is written about one.
    const simulated = dispute?.detail?.simulated === true;
    if (dispute) {
      ctx.evidence.add({ letter: 'C', act: 'dispute', kind: 'ref', title: 'What the provider delivered, stored verbatim', uri: dispute.deliveredUri, hash: dispute.deliveredHash });
      ctx.evidence.add({
        letter: 'D',
        act: 'dispute',
        kind: 'ref',
        title: simulated ? `Dispute simulated, nothing filed (${getDispute().name} adapter)` : `Dispute ${dispute.disputeId} opened (${getDispute().name} adapter)`,
        uri: dispute.uri,
        gatewayUrl: dispute.gatewayUrl,
        url: dispute.url !== dispute.gatewayUrl ? dispute.url : undefined,
        detail: { expected: dispute.expected, claim: dispute.claim, providerAgentId: dispute.providerAgentId, ...dispute.detail },
      });
    } else if (failed) {
      log.error(`the dispute was not opened: ${failed.error}`);
      const uncertain = /may already exist|may have been sent|reverted/.test(failed.error);
      ctx.evidence.add({
        letter: 'D',
        act: 'dispute',
        kind: 'note',
        title: `${uncertain ? 'Dispute may exist, unresolved' : 'Dispute not opened'} (${failed.adapter}): ${failed.error.split('\n')[0].slice(0, 160)}`,
        detail: { error: failed.error, receiptTxHash: failed.receiptTxHash },
      });
    } else {
      ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'note', title: 'No dispute opened', detail: { response: response?.body.slice(0, 200) } });
    }
    if (memory) {
      ctx.evidence.add({ letter: 'C', act: 'dispute', kind: 'ref', title: `Memory after the dispute (${memory.entries} entries)`, uri: memory.uri, hash: memory.hash, gatewayUrl: memory.gatewayUrl });
    }

    if (dispute && simulated) log.warn('the Kleros filing was a simulation: no "dispute" feedback and no ruling are written');
    if (dispute && !simulated) {
      say(`Dispute ${dispute.disputeId} is filed with Kleros. Independent jurors will read the claim, the payment and the report that came back.`);
      // The payment the dispute is about, which is not necessarily the act's last one.
      const paid = ctx.artifacts.find((a) => a.kind === 'x402_receipt' && a.txHash?.toLowerCase() === dispute.receiptTxHash.toLowerCase()) as typeof receipt;
      // Feedback lands on SHADY_AGENT_ID only for a dispute about our shady endpoint; another provider is not ours to name.
      const ours = sameEndpoint(dispute.providerEndpoint, SHADY_REPORT_URL);
      const providerId = ours ? shadyAgentId : undefined;
      if (!ours) log.warn(`the dispute is about ${dispute.providerEndpoint}, not the shady provider: no feedback is written on the provider`);
      const payTo = dispute.payeeSource === 'advertised' ? '' : (dispute.payee ?? (ours ? gate.payTo : ''));
      const payer = ((paid ?? receipt)?.raw.authorization as { from?: string } | undefined)?.from;
      const proof = { fromAddress: ctx.evidence.data.agentAddress ?? payer ?? roleAddress('agent'), toAddress: payTo, chainId: String(CHAIN_ID), txHash: dispute.receiptTxHash };
      const pending: PendingRuling = {
        disputeId: dispute.disputeId,
        adapter: getDispute().name,
        ref: typeof dispute.detail?.filing === 'string' ? dispute.detail.filing : undefined,
        agentId,
        shadyAgentId: providerId,
        proof,
        url: dispute.url,
      };
      const markPending = (title: string) => ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'note', title, url: dispute.url, detail: { pending: true, ...pending } });

      if (providerId && (paid ?? receipt)?.txHash) {
        say(`The agent leaves its own review on ERC-8004: −100 on provider ${providerId}, with the evidence attached.`);
        // Broadcast is enough for the board: a node that times out on the receipt does not unsend the transaction.
        let broadcast: { txHash: string; ref: StoredRef } | undefined;
        const disputeExhibit = (txHash: string, ref: StoredRef, unconfirmed?: boolean) =>
          ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'tx', title: `The agent writes "dispute" on provider ${providerId}`, txHash, uri: ref.uri, hash: ref.hash, gatewayUrl: ref.gatewayUrl, detail: { value: -100, tag2: 'junk-response', ...(unconfirmed ? { receipt: 'not confirmed when the act ended' } : {}) } });
        try {
          const neg = await writeFeedback({
            role: 'agent',
            agentId: providerId,
            value: -100,
            tag1: TAGS.dispute,
            tag2: 'junk-response',
            endpoint: SHADY_REPORT_URL,
            proofOfPayment: proof,
            evidence: { disputeId: dispute.disputeId, dispute: dispute.uri, delivered: { uri: dispute.deliveredUri, hash: dispute.deliveredHash }, expected: dispute.expected },
            onSent: (txHash, ref) => {
              broadcast = { txHash, ref };
            },
          });
          if (neg) disputeExhibit(neg.txHash, neg.ref);
        } catch (err) {
          if (!kleros) throw err;
          if (broadcast) {
            log.warn(`the "dispute" feedback on provider ${providerId} was sent (tx ${broadcast.txHash}) but its receipt did not come back: ${errorLine(err)}`);
            disputeExhibit(broadcast.txHash, broadcast.ref, true);
          } else {
            log.error(`the "dispute" feedback on provider ${providerId} failed: ${errorLine(err)}`);
            actError ??= err; // the act still fails, once the dispute is on record
          }
        }
      }

      let ruling: Ruling | null = null;
      try {
        ruling = await getDispute().ruling(dispute.disputeId, { waitMs: env.rulingWaitMs, ref: pending.ref });
      } catch (err) {
        if (!kleros) throw err;
        log.warn(`reading the ruling of dispute ${dispute.disputeId} failed: ${(err as Error).message.split('\n')[0]}`);
      }
      if (!ruling) {
        say(`The jurors are voting on dispute ${dispute.disputeId}. When the vote is over, the ruling comes back here.`);
        log.ops(`no ruling yet for dispute ${dispute.disputeId} (${getDispute().name}): /act ruling, or pnpm act:ruling --wait <ms>, writes it once the jurors have voted`);
        markPending(`Ruling pending (${getDispute().name})`);
      } else {
        try {
          await recordRuling(ctx, pending, ruling);
        } catch (err) {
          if (kleros) markPending(`Ruling read, not fully written (${getDispute().name})`);
          throw err;
        }
      }
    }
  } finally {
    await gate.stop();
  }
  if (actError) throw actError;

  // Closing statements are ready before the vote opens. Best effort.
  if (process.env.ANTHROPIC_API_KEY) {
    for (const role of ['prosecutor', 'defense'] as const) {
      try {
        log.host(`${role} closing statement`);
        await crossExamine({ role, evidence: ctx.evidence, memory: ctx.memory });
      } catch (err) {
        log.warn(`${role} statement failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }
}

/** What writing a ruling needs. Kept on the "Ruling pending" exhibit so pnpm act:ruling can finish later. */
export interface PendingRuling {
  disputeId: string;
  adapter: string;
  /** The adapter's own id for this filing (kleros: service/chain/receipt), unique where dispute ids are not. */
  ref?: string;
  agentId: string;
  /** Unset when the provider has no ERC-8004 identity: only the defendant's half is written. */
  shadyAgentId?: string;
  proof: { fromAddress: string; toAddress: string; chainId: string; txHash: string };
  url?: string;
}

/**
 * What of each ruling is on chain, so act 4, act:ruling and the session agree
 * across processes and no half is ever written twice. A half is reserved
 * ("sending") before it is signed and gets its transaction as soon as it is
 * broadcast. The ruling is pinned with the first reservation, so both halves
 * carry the same one even if an appeal changes it between them.
 */
const RULINGS_FILE = `${RUN_DIR}/rulings.json`;
type Half = 'provider' | 'agent';
interface HalfState {
  state: 'sending' | 'sent' | 'done';
  tx?: string;
  ref?: StoredRef;
  /** sending, after signing began with no answer from the node: it may be on chain. */
  inDoubt?: boolean;
  /** done with nothing written: the ruling did not uphold the complaint. */
  skipped?: boolean;
  at: string;
}
interface Written {
  ruling?: Ruling;
  provider?: HalfState;
  agent?: HalfState;
}

function rulingKey(p: Pick<PendingRuling, 'adapter' | 'disputeId' | 'ref'>): string {
  return `${p.adapter}:${p.ref ?? p.disputeId}`;
}

/** A missing file is empty; a broken one stops everything rather than reading as "nothing written". */
function readWritten(): Record<string, Written> {
  let text: string;
  try {
    text = readFileSync(RULINGS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(text) as Record<string, Written>;
  } catch (err) {
    throw new Error(`${RULINGS_FILE} is not valid JSON (${(err as Error).message}); fix it by hand before any ruling is written`);
  }
}

/** Read-modify-write of one entry under the lock. */
function updateWritten<T>(key: string, fn: (w: Written) => { next?: Written; result: T }): T {
  return withFileLock(RULINGS_FILE, () => {
    const all = readWritten();
    const out = fn(all[key] ?? {});
    if (out.next) {
      all[key] = out.next;
      const tmp = `${RULINGS_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
      renameSync(tmp, RULINGS_FILE);
    }
    return out.result;
  });
}

/** Every half this ruling needs is on chain. */
export function rulingWritten(p: Pick<PendingRuling, 'adapter' | 'disputeId' | 'ref' | 'shadyAgentId'>): boolean {
  const w = readWritten()[rulingKey(p)];
  return w?.agent?.state === 'done' && (!p.shadyAgentId || w?.provider?.state === 'done');
}

/** A half that was broadcast but never confirmed here: done if its receipt says so. */
async function confirmSent(key: string, half: Half, s: HalfState): Promise<boolean> {
  if (s.state !== 'sent' || !s.tx) return false;
  const receipt = await publicClient.getTransactionReceipt({ hash: s.tx as Hex }).catch(() => null);
  if (receipt?.status !== 'success') return false;
  updateWritten(key, (w) => ({ next: { ...w, [half]: { ...s, state: 'done' } }, result: undefined }));
  return true;
}

/**
 * No answer from the node (a timeout, a dropped connection): the transaction may have gone out. An explicit
 * refusal means it did not, and so does a failed gas estimate: viem estimates before it signs.
 */
function noAnswer(err: unknown): boolean {
  if (!(err instanceof BaseError)) return true;
  if (err.walk((e) => (e as Error).name === 'EstimateGasExecutionError')) return false;
  const silent = err.walk((e) => ['TimeoutError', 'HttpRequestError', 'SocketClosedError', 'WebSocketRequestError'].includes((e as Error).name)) as (Error & { body?: unknown }) | null;
  if (!silent) return false;
  // viem keeps the JSON-RPC request: a nonce, fee or gas read that went unanswered came before anything was signed.
  const method = (silent.body as { method?: string } | undefined)?.method;
  return method === undefined || method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction';
}

/** One line for the operator, with the revert reason viem puts on a line of its own. */
export function errorLine(err: unknown): string {
  const text = err instanceof BaseError ? err.shortMessage : (err as Error).message;
  return text.replace(/\s*\n\s*/g, ' ').slice(0, 300);
}

/** Only an upheld complaint is written: the provider -100, the buyer +100. */
function halfOf(half: Half, p: PendingRuling) {
  return half === 'provider'
    ? { agentId: p.shadyAgentId, value: -100, tag2: 'complainant-wins', title: 'Ruling on the provider: complainant' }
    : { agentId: p.agentId, value: 100, tag2: 'complaint-upheld', title: 'Ruling on the defendant: complaint upheld' };
}

/**
 * The arbitrator key writes the ruling on both parties, quoting the adapter's
 * proof. A half already on chain is not written again (its exhibit is added if
 * this run lacks it); a half in doubt is left for a human.
 *
 * As the Kleros brief has it, a rejected claim (the delivery matched) and a
 * refusal or tie write no feedback on either party: the halves are marked done
 * with nothing on chain, and one note exhibit says so.
 */
export async function recordRuling(ctx: ActContext, p: PendingRuling, fresh: Ruling) {
  const key = rulingKey(p);
  const verdict =
    fresh.winner === 'complainant'
      ? 'the jurors accepted the claim. The report was not what was sold'
      : fresh.winner === 'respondent'
        ? 'the jurors rejected the claim. The delivery matched the offer'
        : 'the jurors did not decide the case';
  say(`Final ruling on dispute ${p.disputeId}: ${verdict}.`);
  log.info(fresh.rationale);
  if (fresh.winner === 'complainant') say('The ruling becomes reputation: −100 on the provider and +100 on the buyer, each citing the Kleros case.');
  let unwritten: Ruling | undefined;
  let wrote = 0;
  // A half that fails does not stop the other: its error is thrown once both were tried.
  let failure: unknown;
  for (const half of ['provider', 'agent'] as Half[]) {
    if (half === 'provider' && !p.shadyAgentId) {
      log.warn('the provider has no ERC-8004 identity: no ruling is written on it');
      continue;
    }
    // Reserve the half and pin the ruling in one locked step: the first reservation decides the ruling for both.
    const claim = updateWritten<{ held?: HalfState; ruling: Ruling }>(key, (w) => {
      if (w[half]) return { result: { held: w[half], ruling: w.ruling ?? fresh } };
      const ruling = (w.provider || w.agent) && w.ruling ? w.ruling : fresh;
      return { next: { ...w, ruling, [half]: { state: 'sending', at: new Date().toISOString() } }, result: { ruling } };
    });
    const { ruling } = claim;
    const h = halfOf(half, p);
    if (claim.held) {
      const held = claim.held;
      if (held.skipped) {
        unwritten = ruling;
      } else if (held.state === 'done' || (await confirmSent(key, half, held))) {
        log.info(`the ruling on the ${half} is already on chain (tx ${held.tx})`);
        ctx.evidence.reload(); // another process may have added its exhibit while this one waited for the ruling
        if (held.tx && held.ref && !ctx.evidence.data.exhibits.some((e) => e.txHash === held.tx)) {
          ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'tx', title: h.title, txHash: held.tx, uri: held.ref.uri, hash: held.ref.hash, gatewayUrl: held.ref.gatewayUrl, url: ruling.proofUrl, detail: { disputeId: p.disputeId, rationale: ruling.rationale, proofUrl: ruling.proofUrl } });
        }
      } else {
        const where = held.tx ? celoscanTx(held.tx) : `the arbitrator's transactions since ${held.at}${hasRole('arbitrator') ? `, ${celoscanAddress(roleAddress('arbitrator'))}` : ''}`;
        log.warn(`the ruling on the ${half} may already be on chain; not writing it twice. Check ${where}, then fix "${key}" in ${RULINGS_FILE}`);
      }
      continue;
    }
    if (ruling.winner !== fresh.winner) log.warn(`the ruling now reads ${fresh.winner}, but ${ruling.winner} is already on one party; writing ${ruling.winner} on the ${half} so they agree`);
    if (ruling.winner !== 'complainant') {
      updateWritten(key, (w) => ({ next: { ...w, [half]: { state: 'done', skipped: true, at: new Date().toISOString() } }, result: undefined }));
      unwritten = ruling;
      continue;
    }

    let signing = false;
    let sent = false;
    const free = () =>
      updateWritten(key, (w) => {
        const next: Written = { ...w, [half]: undefined };
        if (!next.provider && !next.agent) next.ruling = undefined; // nothing of it is on chain: do not pin it
        return { next, result: undefined };
      });
    try {
      const fb = await writeFeedback({
        role: 'arbitrator',
        agentId: h.agentId!,
        value: h.value,
        tag1: TAGS.ruling,
        tag2: h.tag2,
        endpoint: SHADY_REPORT_URL,
        proofOfPayment: p.proof,
        evidence: { disputeId: p.disputeId, rationale: ruling.rationale, ruling: ruling.ref?.uri, externalId: ruling.externalId, proofUrl: ruling.proofUrl },
        onSigning: () => {
          signing = true;
        },
        onSent: (tx, ref) => {
          sent = true;
          updateWritten(key, (w) => ({ next: { ...w, [half]: { state: 'sent', tx, ref, at: new Date().toISOString() } }, result: undefined }));
        },
      });
      if (!fb) {
        free(); // declined: nothing signed
        continue;
      }
      updateWritten(key, (w) => ({ next: { ...w, [half]: { state: 'done', tx: fb.txHash, ref: fb.ref, at: new Date().toISOString() } }, result: undefined }));
      wrote++;
      ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'tx', title: h.title, txHash: fb.txHash, uri: fb.ref.uri, hash: fb.ref.hash, gatewayUrl: fb.ref.gatewayUrl, url: ruling.proofUrl, detail: { disputeId: p.disputeId, rationale: ruling.rationale, proofUrl: ruling.proofUrl } });
    } catch (err) {
      // Broadcast: it stays "sent" for the next run to confirm. Signing with no answer: in doubt, for a human. Otherwise nothing went out.
      if (!sent && signing && noAnswer(err)) updateWritten(key, (w) => ({ next: { ...w, [half]: { state: 'sending', inDoubt: true, at: new Date().toISOString() } }, result: undefined }));
      else if (!sent) free();
      log.error(`the ruling on the ${half} was not written: ${errorLine(err)}`);
      failure ??= err;
    }
  }
  if (unwritten) ctx.evidence.reload();
  if (unwritten && !ctx.evidence.data.exhibits.some((e) => e.kind === 'note' && e.detail?.noFeedback === true && e.detail?.disputeId === p.disputeId)) {
    const what = unwritten.winner === 'respondent' ? 'claim rejected, the delivery matched' : 'no decision (refused or tied)';
    say(`${unwritten.winner === 'respondent' ? 'The claim was rejected' : 'There is no decision'}, so no review is written on either side.`);
    ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'note', title: `Ruling: ${what}. No feedback written`, url: unwritten.proofUrl, detail: { disputeId: p.disputeId, noFeedback: true, winner: unwritten.winner, rationale: unwritten.rationale, proofUrl: unwritten.proofUrl } });
  }
  if (wrote > 0 && !failure) say('Both reviews are on ERC-8004, linked to the case. Anyone can check them.');
  if (failure) throw failure;
}

if (isMain(import.meta.url)) asScript('dispute', disputeAct);
