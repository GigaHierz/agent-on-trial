import { CHAIN_ID, TAGS } from '@trial/shared';
import { lastArtifact, type ActContext } from '../agent/context.js';
import { crossExamine } from '../agent/cross.js';
import { runAct } from '../agent/loop.js';
import { getDispute } from '../adapters/dispute/index.js';
import { describeReceipt } from '../lib/buy.js';
import { env } from '../lib/env.js';
import { replayFixture } from '../lib/evidence.js';
import { writeFeedback } from '../lib/feedback.js';
import { log } from '../lib/log.js';
import { startShadyGate, SHADY_REPORT_URL } from '../shady-provider/gate.js';
import { asScript, isMain } from './run.js';

/**
 * Act 4: a purchase goes wrong.
 * The agent buys a "market report" from a provider with no reputation, gets
 * junk, and opens a dispute through the dispute adapter. The agent writes
 * negative feedback on the provider; the arbitrator writes the ruling on both.
 */
export async function disputeAct(ctx: ActContext) {
  if (env.fixture) return replayFixture(ctx.evidence, 'dispute');
  const agentId = ctx.evidence.data.agentId ?? env.agentId;
  if (!agentId) throw new Error('no agent id; run act identity first');
  const shadyAgentId = ctx.evidence.data.shadyAgentId ?? env.shadyAgentId;
  if (!shadyAgentId) log.warn('SHADY_AGENT_ID unset: the provider has no identity, so no feedback can be written on it (pnpm shady:register)');

  const gate = await startShadyGate();
  try {
    ctx.params.shadyUrl = SHADY_REPORT_URL;
    ctx.params.shadyAgentId = shadyAgentId;
    await runAct(ctx, 'dispute', null);

    const receipt = lastArtifact(ctx, 'x402_receipt');
    const response = lastArtifact(ctx, 'x402_response');
    const dispute = lastArtifact(ctx, 'dispute');
    const memory = lastArtifact(ctx, 'memory');

    if (receipt?.txHash) {
      ctx.evidence.add({
        letter: 'B',
        act: 'dispute',
        kind: 'tx',
        title: `Paid ${describeReceipt(receipt).amount} ${describeReceipt(receipt).asset} through x402 to the shady provider`,
        txHash: receipt.txHash,
        detail: { url: receipt.url, payTo: receipt.raw.payTo ?? gate.payTo },
      });
    } else {
      log.warn('the shady purchase did not settle');
    }
    if (dispute) {
      ctx.evidence.add({ letter: 'C', act: 'dispute', kind: 'ref', title: 'What the provider delivered, stored verbatim', uri: dispute.deliveredUri, hash: dispute.deliveredHash });
      ctx.evidence.add({
        letter: 'D',
        act: 'dispute',
        kind: 'ref',
        title: `Dispute ${dispute.disputeId} opened (${getDispute().name} adapter)`,
        uri: dispute.uri,
        gatewayUrl: dispute.url,
        detail: { expected: dispute.expected, claim: dispute.claim, providerAgentId: dispute.providerAgentId },
      });
    } else {
      ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'note', title: 'No dispute opened', detail: { response: response?.body.slice(0, 200) } });
    }
    if (memory) {
      ctx.evidence.add({ letter: 'C', act: 'dispute', kind: 'ref', title: `Memory after the dispute (${memory.entries} entries)`, uri: memory.uri, hash: memory.hash, gatewayUrl: memory.gatewayUrl });
    }

    if (dispute && shadyAgentId && receipt?.txHash) {
      const proof = { fromAddress: ctx.evidence.data.agentAddress ?? '', toAddress: String(receipt.raw.payTo ?? gate.payTo), chainId: String(CHAIN_ID), txHash: receipt.txHash };
      const neg = await writeFeedback({
        role: 'agent',
        agentId: shadyAgentId,
        value: -100,
        tag1: TAGS.dispute,
        tag2: 'junk-response',
        endpoint: SHADY_REPORT_URL,
        proofOfPayment: proof,
        evidence: { disputeId: dispute.disputeId, dispute: dispute.uri, delivered: { uri: dispute.deliveredUri, hash: dispute.deliveredHash }, expected: dispute.expected },
      });
      if (neg) {
        ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'tx', title: `The agent writes "dispute" on provider ${shadyAgentId}`, txHash: neg.txHash, uri: neg.ref.uri, hash: neg.ref.hash, gatewayUrl: neg.ref.gatewayUrl, detail: { value: -100, tag2: 'junk-response' } });
      }

      const ruling = await getDispute().ruling(dispute.disputeId, { waitMs: 30_000 });
      if (!ruling) {
        log.warn(`dispute ${dispute.disputeId} is pending with the ${getDispute().name} adapter; no ruling yet`);
        ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'note', title: `Ruling pending (${getDispute().name})`, detail: { disputeId: dispute.disputeId } });
      } else {
        log.host(`ruling: ${ruling.winner} — ${ruling.rationale}`);
        const upheld = ruling.winner === 'complainant';
        const onProvider = await writeFeedback({
          role: 'arbitrator',
          agentId: shadyAgentId,
          value: upheld ? -100 : 0,
          tag1: TAGS.ruling,
          tag2: upheld ? 'complainant-wins' : ruling.winner === 'respondent' ? 'respondent-wins' : 'refused',
          endpoint: SHADY_REPORT_URL,
          proofOfPayment: proof,
          evidence: { disputeId: dispute.disputeId, rationale: ruling.rationale, ruling: ruling.ref?.uri, externalId: ruling.externalId, proofUrl: ruling.proofUrl },
        });
        if (onProvider) ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'tx', title: `Ruling on the provider: ${ruling.winner}`, txHash: onProvider.txHash, uri: onProvider.ref.uri, hash: onProvider.ref.hash, gatewayUrl: onProvider.ref.gatewayUrl, detail: { rationale: ruling.rationale, proofUrl: ruling.proofUrl } });
        const onAgent = await writeFeedback({
          role: 'arbitrator',
          agentId,
          value: upheld ? 100 : 0,
          tag1: TAGS.ruling,
          tag2: upheld ? 'complaint-upheld' : 'complaint-rejected',
          endpoint: SHADY_REPORT_URL,
          proofOfPayment: proof,
          evidence: { disputeId: dispute.disputeId, rationale: ruling.rationale, ruling: ruling.ref?.uri },
        });
        if (onAgent) ctx.evidence.add({ letter: 'D', act: 'dispute', kind: 'tx', title: `Ruling on the defendant: complaint ${upheld ? 'upheld' : 'rejected'}`, txHash: onAgent.txHash, uri: onAgent.ref.uri, hash: onAgent.ref.hash, gatewayUrl: onAgent.ref.gatewayUrl });
      }
    }
  } finally {
    await gate.stop();
  }

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

if (isMain(import.meta.url)) asScript('dispute', disputeAct);
