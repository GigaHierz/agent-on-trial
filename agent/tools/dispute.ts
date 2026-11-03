import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { CAIP2, DEMO_TOKEN, canonicalJson } from '@trial/shared';
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { getDispute } from '../../adapters/dispute/index.js';
import type { DisputeEvidence } from '../../adapters/dispute/types.js';
import { getStorage } from '../../adapters/storage/index.js';
import { approve } from '../../lib/approve.js';
import { paidAmount, settlementPayee } from '../../lib/buy.js';
import { env, hasRole, roleAddress } from '../../lib/env.js';
import { log } from '../../lib/log.js';
import { SHADY_REPORT_URL } from '../../shady-provider/gate.js';
import { shadyChallenge } from './dry-run-buy.js';
import { lastArtifact, type ActContext } from '../context.js';

/**
 * open_dispute: the agent's side of the dispute plug-in. The adapter stores
 * the evidence and returns an id. The negative feedback on the provider and
 * the ruling are written by the step after the act, not by the model.
 */
export function disputeTools(ctx: ActContext) {
  const open_dispute = betaZodTool({
    name: 'open_dispute',
    description: 'Open a dispute against a provider that took payment and delivered something that does not match the advertised spec. Returns the dispute id and where the evidence is stored.',
    inputSchema: z.object({
      providerAgentId: z.string().regex(/^\d+$/).optional().describe('The provider\'s ERC-8004 agent id, if it has one.'),
      providerEndpoint: z.string().url().describe('The URL you paid.'),
      receiptTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('The settlement transaction of your payment.'),
      expected: z.string().min(5).max(2000).describe('The advertised spec, e.g. "a Celo market report with sections: price, volume, sources".'),
      deliveredBody: z.string().describe('What the provider returned, verbatim.'),
      claim: z.string().min(10).max(1200).describe('One paragraph: what you paid for, what you got, why it falls short.'),
    }),
    run: async (input) => {
      log.toolCall('open_dispute', { ...input, deliveredBody: input.deliveredBody.slice(0, 120) });
      const storage = getStorage();
      const delivered = await storage.put(input.deliveredBody, { contentType: 'text/plain', name: 'delivered.txt' });
      const adapter = getDispute();
      // The settled payment this dispute is about, from what the tools recorded: the one with the hash the
      // model named, else the latest one to the endpoint it named. The Kleros adapter files once per receipt.
      const receipts = ctx.artifacts.filter((a): a is Extract<typeof a, { kind: 'x402_receipt' }> => a.kind === 'x402_receipt' && Boolean(a.txHash)).reverse();
      const byHash = receipts.find((r) => r.txHash!.toLowerCase() === input.receiptTxHash.toLowerCase());
      // A hash that belongs to a payment to another endpoint is the wrong payment, not a typo.
      const matched = byHash ? (sameEndpoint(byHash.url, input.providerEndpoint) ? byHash : undefined) : receipts.find((r) => sameEndpoint(r.url, input.providerEndpoint));
      const agentId = ctx.evidence.data.agentId ?? env.agentId;
      if (adapter.name === 'kleros' && (!matched || !agentId)) {
        const error = !agentId
          ? 'the agent has no ERC-8004 id yet (run act identity); a Kleros dispute names the complainant by it'
          : byHash
            ? `receipt ${input.receiptTxHash} paid ${byHash.url}, not ${input.providerEndpoint}; a Kleros dispute is only filed over the payment it is about`
            : `no settled x402 receipt matches ${input.receiptTxHash} or ${input.providerEndpoint}; a Kleros dispute is only filed over a payment this agent made`;
        ctx.artifacts.push({ kind: 'dispute_failed', adapter: adapter.name, receiptTxHash: input.receiptTxHash, error });
        return `The dispute was not opened: ${error}.`;
      }
      const receipt = matched ?? lastArtifact(ctx, 'x402_receipt');
      const receiptTxHash = (matched?.txHash ?? input.receiptTxHash) as Hex;
      if (receiptTxHash.toLowerCase() !== input.receiptTxHash.toLowerCase()) log.warn(`open_dispute named receipt ${input.receiptTxHash}; using the settled payment to ${matched?.url}, ${receiptTxHash}`);
      const receiptRef = await storage.put(canonicalJson(receipt?.raw ?? { txHash: input.receiptTxHash, url: input.providerEndpoint }), { name: 'receipt.json' });
      const requirements = await requirementsOf(input.providerEndpoint);
      const shady = Boolean(ctx.params.shadyUrl && sameEndpoint(input.providerEndpoint, ctx.params.shadyUrl));
      const payer = (receipt?.raw?.authorization as { from?: string } | undefined)?.from;
      // Who was paid: the settlement on Celo; else the payTo of the challenge the buyer signed; else our own shady
      // provider's; last, what the endpoint advertises now, which the provider controls and is labelled as such.
      const sources: [NonNullable<DisputeEvidence['respondent']['addressSource']>, () => Promise<Address | undefined> | Address | undefined][] = [
        ['settlement', () => payeeOf(receiptTxHash, payer && isAddress(payer) ? payer : roleAddress('agent'), receipt?.asset, receipt?.amount)],
        ['challenge', () => signedPayTo(ctx, input.providerEndpoint, receiptTxHash)],
        ['ours', () => (shady ? (env.shadyPayTo ?? (hasRole('shady') ? roleAddress('shady') : undefined)) : undefined)],
        ['advertised', () => payToOf(requirements, receipt?.asset)],
      ];
      let payee: Address | undefined;
      let payeeSource: DisputeEvidence['respondent']['addressSource'];
      for (const [source, read] of sources) {
        payee = await read();
        if (payee) {
          payeeSource = source;
          break;
        }
      }
      if (!payee) log.warn(`could not tell who settlement ${receiptTxHash} paid: the dispute names no provider address`);
      else if (payeeSource === 'advertised') log.warn(`the settlement could not be read: the provider address ${payee} is the one ${input.providerEndpoint} advertises now`);
      // The provider's identity is ours to know when it is our shady provider; the model's word is the fallback.
      const known = shady ? ctx.params.shadyAgentId : undefined;
      if (known && input.providerAgentId && input.providerAgentId !== known) log.warn(`open_dispute named provider agent ${input.providerAgentId}; the provider at ${input.providerEndpoint} is agent ${known}`);
      const providerAgentId = known ?? input.providerAgentId;
      const paid = paidAmount(receipt?.amount ?? '10000', receipt?.asset ?? DEMO_TOKEN.address);
      if (adapter.name === 'kleros' && !(await approve(`file a Kleros dispute over receipt ${receiptTxHash} (pays an arbitration fee)`))) {
        return 'The host declined filing this dispute. Do not retry it.';
      }
      let result: Awaited<ReturnType<typeof adapter.open>>;
      try {
        result = await adapter.open({
          complainant: { address: roleAddress('agent'), agentId: agentId ?? '0' },
          respondent: {
            address: payee ?? ('0x0000000000000000000000000000000000000000' as Address),
            agentId: providerAgentId,
            endpoint: input.providerEndpoint,
            addressSource: payeeSource,
          },
          receipt: {
            txHash: receiptTxHash,
            amount: paid.amount,
            symbol: paid.symbol,
            amountAtomic: paid.amountAtomic,
            asset: getAddress(receipt?.asset && /^0x/.test(receipt.asset) ? receipt.asset : DEMO_TOKEN.address),
            network: CAIP2,
            receiptRef,
          },
          expected: input.expected,
          requirements,
          delivered,
          memory: ctx.memory.head ?? undefined,
          claim: input.claim,
        });
      } catch (err) {
        const error = (err as Error).message;
        ctx.artifacts.push({ kind: 'dispute_failed', adapter: adapter.name, receiptTxHash, error });
        log.toolResult('open_dispute', `failed: ${error.split('\n')[0]}`);
        return `The dispute could not be opened: ${error}\nDo not retry it; the host will look at it.`;
      }
      ctx.artifacts.push({
        kind: 'dispute',
        disputeId: result.disputeId,
        uri: result.uri,
        gatewayUrl: result.gatewayUrl,
        url: result.url,
        detail: result.detail,
        providerAgentId,
        providerEndpoint: input.providerEndpoint,
        payee,
        payeeSource,
        receiptTxHash,
        expected: input.expected,
        deliveredUri: delivered.uri,
        deliveredHash: delivered.hash,
        claim: input.claim,
      });
      log.toolResult('open_dispute', `${result.disputeId} evidence ${result.uri.slice(0, 40)}…`);
      const status = result.detail?.simulated ? 'simulated: nothing was filed and no dispute exists' : 'open';
      return JSON.stringify({ disputeId: result.disputeId, evidenceUri: result.uri, url: result.url, status });
    },
  });
  return [open_dispute];
}

async function payeeOf(txHash: Hex, payer: Address, asset?: string, amountAtomic?: string): Promise<Address | undefined> {
  if (env.dryRun) return undefined; // a made-up settlement is not on Celo: the signed challenge names the payee
  try {
    return await settlementPayee(txHash, payer, asset, amountAtomic);
  } catch (err) {
    log.warn(`could not read settlement ${txHash} on Celo: ${(err as Error).message.split('\n')[0]}`);
    return undefined;
  }
}

const REQUIREMENTS_MAX = 16_384;

/**
 * The x402 payment requirements the endpoint serves to an unpaid request, for
 * the jurors: what the provider itself advertised, next to what it delivered.
 * Nothing is paid (no payment header). The provider's content, kept as data.
 */
async function requirementsOf(url: string): Promise<DisputeEvidence['requirements']> {
  if (env.dryRun) return sameEndpoint(url, SHADY_REPORT_URL) ? { url, x402: shadyChallenge() } : undefined;
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    if (res.status !== 402) return undefined;
    const header = res.headers.get('payment-required'); // x402 v2 puts them in this header, base64 JSON; v1 in the body
    const text = header ? Buffer.from(header, 'base64').toString('utf8') : await readCapped(res, REQUIREMENTS_MAX);
    if (text === undefined || text.length > REQUIREMENTS_MAX) return undefined;
    return { url, x402: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** The body, or undefined as soon as it passes max bytes: a hostile endpoint cannot make us buffer more. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  if (Number(res.headers.get('content-length') ?? 0) > max) return undefined;
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The payTo an x402 challenge names for this asset (v1 and v2 both list offers under accepts). */
function payToOf(requirements: DisputeEvidence['requirements'], asset?: string): Address | undefined {
  const accepts = (requirements?.x402 as { accepts?: { payTo?: unknown; asset?: unknown }[] } | undefined)?.accepts;
  if (!Array.isArray(accepts)) return undefined;
  const offer = accepts.find((a) => typeof a?.payTo === 'string' && isAddress(a.payTo) && (!asset || !isAddress(asset) || (typeof a.asset === 'string' && isAddress(a.asset) && isAddressEqual(a.asset, asset))));
  return offer ? getAddress(offer.payTo as string) : undefined;
}

/**
 * The payTo of the x402 challenge buy_curl signed for this payment, from the
 * summary it prints ("402 challenge: … payTo=0x…", then "Settled on …: tx=0x…").
 * Only a completed call's summary is read, the one that names this settlement:
 * what follows "--- response headers ---" is the provider's.
 */
function signedPayTo(ctx: ActContext, endpoint: string, txHash: string): Address | undefined {
  for (const a of ctx.artifacts) {
    if (a.kind !== 'x402_response' || !sameEndpoint(a.url, endpoint)) continue;
    const at = a.body.indexOf('--- response headers ---');
    if (at < 0) continue;
    const summary = a.body.slice(0, at);
    if (!new RegExp(`^Settled on .*\\btx=${txHash}\\b`, 'im').test(summary)) continue;
    const m = summary.match(/^402 challenge: .*\bpayTo=(0x[0-9a-fA-F]{40})\b/m);
    if (m) return getAddress(m[1]);
  }
  return undefined;
}

export function sameEndpoint(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/$/, '')}${x.search}`;
    } catch {
      return u.trim().replace(/\/$/, '');
    }
  };
  return norm(a) === norm(b);
}
