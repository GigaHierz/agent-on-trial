import { CHAIN_ID, TAGS, USEBUY_URL, canonicalJson } from '@trial/shared';
import { lastArtifact, type ActContext } from '../agent/context.js';
import { runAct } from '../agent/loop.js';
import { getStorage } from '../adapters/storage/index.js';
import type { Address, Hex } from 'viem';
import { ensureBuyAccount, paidAmount, settlementPayee } from '../lib/buy.js';
import { env, roleAddress } from '../lib/env.js';
import { replayFixture } from '../lib/evidence.js';
import { writeFeedback } from '../lib/feedback.js';
import { log } from '../lib/log.js';
import { asScript, isMain } from './run.js';

/**
 * Act 3: buy something useful.
 * The agent pays a usebuy.ai API through x402 in USD₮; the facilitator
 * settles on Celo. The receipt is stored and the witness writes "paid".
 */
export async function spendAct(ctx: ActContext) {
  if (env.fixture) return replayFixture(ctx.evidence, 'spend');
  const agentId = ctx.evidence.data.agentId ?? env.agentId;
  if (!agentId) throw new Error('no agent id; run act identity first');

  const acct = await ensureBuyAccount();
  log.info(`buy account "defendant" ${acct.created ? 'imported' : 'ready'}${acct.address ? ` · ${acct.address}` : ''}`);
  if (!ctx.params.propertyUrl) ctx.params.propertyUrl = lastPropertyUrl(ctx);

  // In the session, artifacts accumulate across acts: only this act's.
  const from = ctx.artifacts.length;
  await runAct(ctx, 'spend', null);

  const receipt = lastArtifact(ctx, 'x402_receipt', from);
  const memory = lastArtifact(ctx, 'memory', from);
  if (memory) {
    ctx.evidence.add({ letter: 'C', act: 'spend', kind: 'ref', title: `Memory after spending (${memory.entries} entries)`, uri: memory.uri, hash: memory.hash, gatewayUrl: memory.gatewayUrl });
  }
  if (!receipt?.txHash) {
    log.warn('no settled x402 receipt this time');
    ctx.evidence.add({ letter: 'B', act: 'spend', kind: 'note', title: 'No x402 payment settled', detail: { response: lastArtifact(ctx, 'x402_response', from)?.body.slice(0, 200) } });
    return;
  }

  const stored = await getStorage().put(canonicalJson(receipt.raw), { name: 'receipt.json' });
  ctx.evidence.add({
    letter: 'B',
    act: 'spend',
    kind: 'tx',
    title: `Paid ${paidAmount(receipt.amount, receipt.asset).label} through x402 for ${new URL(receipt.url).pathname}`,
    txHash: receipt.txHash,
    detail: { url: receipt.url, network: receipt.network, settledBy: 'api.x402.celo.org' },
  });
  ctx.evidence.add({ letter: 'C', act: 'spend', kind: 'ref', title: 'x402 receipt stored', uri: stored.uri, hash: stored.hash, gatewayUrl: stored.gatewayUrl });

  // buy's receipts do not record payTo: the settlement's Transfer log says who was paid.
  const payer = ((receipt.raw.authorization as { from?: string } | undefined)?.from ?? ctx.evidence.data.agentAddress ?? roleAddress('agent')) as Address;
  const payTo = (receipt.raw.payTo as string | undefined) ?? (await settlementPayee(receipt.txHash as Hex, payer, receipt.asset, receipt.amount).catch(() => undefined)) ?? '';
  const fb = await writeFeedback({
    role: 'witness',
    agentId,
    value: 100,
    tag1: TAGS.paid,
    tag2: 'x402-exact',
    endpoint: USEBUY_URL,
    proofOfPayment: {
      fromAddress: payer,
      toAddress: payTo,
      chainId: String(CHAIN_ID),
      txHash: receipt.txHash,
    },
    evidence: { url: receipt.url, amount: receipt.amount, asset: receipt.asset, receipt: { uri: stored.uri, hash: stored.hash } },
  });
  if (fb) {
    ctx.evidence.add({
      letter: 'A',
      act: 'spend',
      kind: 'tx',
      title: 'Feedback "paid" written by the witness, receipt hashed on chain',
      txHash: fb.txHash,
      uri: fb.ref.uri,
      hash: fb.ref.hash,
      gatewayUrl: fb.ref.gatewayUrl,
      detail: { tag1: TAGS.paid, tag2: 'x402-exact', value: 100, client: fb.clientAddress },
    });
  }
}

function lastPropertyUrl(ctx: ActContext): string | undefined {
  const b = ctx.evidence.byAct('earn').find((e) => e.kind === 'tx');
  return (b?.detail?.propertyUrl as string | undefined) ?? (env.courtroomUrl ? `${env.courtroomUrl}/property/${ctx.evidence.runId}` : undefined);
}

if (isMain(import.meta.url)) asScript('spend', spendAct);
