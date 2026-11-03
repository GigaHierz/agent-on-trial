import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { DEMO_TOKEN } from '@trial/shared';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { approve } from '../../lib/approve.js';
import { env, roleAddress } from '../../lib/env.js';
import { log } from '../../lib/log.js';
import { SHADY_REPORT_URL } from '../../shady-provider/gate.js';
import type { ActContext } from '../context.js';

/**
 * --dry-run: the buy tools the model gets instead of the buy MCP. The shady
 * provider is played from its own paywall.yml (price, payTo, the junk body),
 * and buy_curl answers in buy's own words and records the same artifacts as
 * the real bridge (agent/tools/buy-mcp.ts), so open_dispute and act 4 run
 * unchanged. Nothing is signed and nothing is paid; the settlement hash is
 * made up. Only the shady provider is played: any other URL is refused.
 */
const here = dirname(fileURLToPath(import.meta.url));

export interface ShadyOffer {
  url: string;
  payTo: Address;
  asset: Address;
  amountAtomic: string;
  description: string;
  body: string;
}

/** What the real gate serves, from shady-provider/paywall.yml. */
export function shadyOffer(): ShadyOffer {
  const yml = readFileSync(join(here, '../../shady-provider/paywall.yml'), 'utf8');
  const body = yml.match(/^\s*body:\s*'(.*)'\s*$/m)?.[1] ?? '{"report":"(junk)"}';
  const description = yml.match(/^\s*description:\s*(.+)$/m)?.[1]?.trim() ?? 'Celo market report';
  return { url: SHADY_REPORT_URL, payTo: (env.shadyPayTo ?? roleAddress('shady')) as Address, asset: DEMO_TOKEN.address as Address, amountAtomic: '10000', description, body };
}

/** The x402 v1 challenge the gate sends to an unpaid request. */
export function shadyChallenge(o = shadyOffer()) {
  return { x402Version: 1, accepts: [{ scheme: 'exact', network: 'celo', maxAmountRequired: o.amountAtomic, asset: o.asset, payTo: o.payTo, resource: o.url, description: o.description, mimeType: 'application/json', maxTimeoutSeconds: 300 }] };
}

const isShady = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.startsWith(`${new URL(SHADY_REPORT_URL).host}/report/`);
  } catch {
    return false;
  }
};

export function dryRunBuyTools(ctx: ActContext) {
  const UrlInput = z.object({
    url: z.string().describe('The URL to fetch.'),
    method: z.string().optional(),
    body: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    token: z.string().optional().describe('Payment token preference. Always pass token USDT.'),
    maxAmount: z.string().optional(),
  });

  const buy_pay_quote = betaZodTool({
    name: 'buy_pay_quote',
    description: 'DRY RUN — never pays, never signs. Fetches a URL and, if it answers 402 Payment Required, returns the x402 price quote: amount, token, payTo, description. Always pass token USDT.',
    inputSchema: UrlInput,
    run: async (input) => {
      log.toolCall('buy_pay_quote', input);
      if (!isShady(input.url)) return `error: no payment required or unreachable: ${input.url}. Nothing was signed or paid.`;
      const o = shadyOffer();
      const quote = { scheme: 'exact', network: 'celo', price: { atomic: o.amountAtomic, token: 'USDT', formatted: '0.01 USDT' }, asset: o.asset, payTo: o.payTo, description: o.description, resource: o.url, maxTimeoutSeconds: 300, selfRequirements: null };
      const text = ['DRY RUN — no payment was made and nothing was signed.', JSON.stringify(quote, null, 2)].join('\n');
      log.toolResult('buy_pay_quote', `quote: 0.01 USDT to ${o.payTo} · ${o.description}`);
      return text;
    },
  });

  const buy_curl = betaZodTool({
    name: 'buy_curl',
    description: 'Fetch a URL, paying its x402 challenge automatically. Always pass token USDT.',
    inputSchema: UrlInput,
    run: async (input) => {
      log.toolCall('buy_curl', input);
      if (!(await approve(`buy_curl pays for ${input.url}`))) return 'The host declined this payment. Do not retry it.';
      if (!isShady(input.url)) {
        log.opsWarn(`dry run: only the shady provider is played; ${input.url} was not fetched`);
        return `error: ${input.url} is unreachable. Nothing was signed or paid.`;
      }
      const o = shadyOffer();
      const payer = roleAddress('agent');
      const txHash = keccak256(toHex(`dry run settlement ${ctx.artifacts.length} ${Date.now()}`)) as Hex;
      const text = [
        'HTTP 200 OK',
        `Wallet: ${payer} on celo (chainId=42220)`,
        `402 challenge: 0.01 USDT, asset=${o.asset}, on celo, payTo=${o.payTo}`,
        `Settled on celo: tx=${txHash}`,
        `Payer: ${payer}`,
        '--- response headers ---\ncontent-type: application/json',
        `--- response body ---\n${o.body}`,
      ].join('\n');
      ctx.artifacts.push({ kind: 'x402_response', url: input.url, body: text });
      const raw = { id: `dry-${txHash.slice(2, 10)}`, account: 'defendant', url: input.url, network: 'eip155:42220', asset: o.asset, amount: o.amountAtomic, scheme: 'exact', txHash, authorization: { from: payer, nonce: keccak256(toHex(txHash)), validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300) }, timestamp: new Date().toISOString(), status: 'settled', outcome: 'paid' };
      ctx.artifacts.push({ kind: 'x402_receipt', url: input.url, txHash, amount: o.amountAtomic, asset: o.asset, network: 'eip155:42220', raw });
      log.ops(`dry run: x402 "settled" 0.01 USD₮ to ${o.payTo} for ${input.url}; nothing was paid and ${txHash.slice(0, 10)}… is made up`);
      log.toolResult('buy_curl', text);
      return text;
    },
  });

  const buy_balance = betaZodTool({
    name: 'buy_balance',
    description: 'Show the wallet balance.',
    inputSchema: z.object({ token: z.string().optional() }),
    run: async () => `Wallet: ${roleAddress('agent')} on celo (chainId=42220)\nUSDT: 1.00\nCELO: 0.20`,
  });

  return [buy_pay_quote, buy_curl, buy_balance];
}
