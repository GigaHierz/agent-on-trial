import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { CAIP2, DEMO_TOKEN, canonicalJson } from '@trial/shared';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { getDispute } from '../../adapters/dispute/index.js';
import { getStorage } from '../../adapters/storage/index.js';
import { roleAddress } from '../../lib/env.js';
import { log, showUri } from '../../lib/log.js';
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
      expected: z.string().min(5).describe('The advertised spec, e.g. "a Celo market report with sections: price, volume, sources".'),
      deliveredBody: z.string().describe('What the provider returned, verbatim.'),
      claim: z.string().min(10).max(1200).describe('One paragraph: what you paid for, what you got, why it falls short.'),
    }),
    run: async (input) => {
      log.toolCall('open_dispute', { ...input, deliveredBody: input.deliveredBody.slice(0, 120) });
      const storage = getStorage();
      const delivered = await storage.put(input.deliveredBody, { contentType: 'text/plain', name: 'delivered.txt' });
      const receipt = lastArtifact(ctx, 'x402_receipt');
      const receiptRef = await storage.put(canonicalJson(receipt?.raw ?? { txHash: input.receiptTxHash, url: input.providerEndpoint }), { name: 'receipt.json' });
      const agentId = ctx.evidence.data.agentId ?? '0';
      const result = await getDispute().open({
        complainant: { address: roleAddress('agent'), agentId },
        respondent: {
          address: (receipt?.raw?.payTo as Address | undefined) ?? ('0x0000000000000000000000000000000000000000' as Address),
          agentId: input.providerAgentId,
          endpoint: input.providerEndpoint,
        },
        receipt: {
          txHash: input.receiptTxHash as Hex,
          amount: receipt?.amount ?? '0.01',
          asset: getAddress(receipt?.asset && /^0x/.test(receipt.asset) ? receipt.asset : DEMO_TOKEN.address),
          network: CAIP2,
          receiptRef,
        },
        expected: input.expected,
        delivered,
        memory: ctx.memory.head ?? undefined,
        claim: input.claim,
      });
      ctx.artifacts.push({
        kind: 'dispute',
        disputeId: result.disputeId,
        uri: result.uri,
        url: result.url,
        providerAgentId: input.providerAgentId,
        providerEndpoint: input.providerEndpoint,
        receiptTxHash: input.receiptTxHash,
        expected: input.expected,
        deliveredUri: delivered.uri,
        deliveredHash: delivered.hash,
        claim: input.claim,
      });
      log.toolResult('open_dispute', `${result.disputeId} evidence ${showUri(result.uri)}`);
      return JSON.stringify({ disputeId: result.disputeId, evidenceUri: result.uri, url: result.url, status: 'open' });
    },
  });
  return [open_dispute];
}

