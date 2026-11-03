import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEMO_TOKEN } from '@trial/shared';
import { parseUnits } from 'viem';
import { approve } from '../../lib/approve.js';
import { mcpServeCommand, paidAmount, receiptsSince } from '../../lib/buy.js';
import { env } from '../../lib/env.js';
import { log } from '../../lib/log.js';
import { dryRunBuyTools } from './dry-run-buy.js';
import type { ActContext } from '../context.js';

/**
 * The buy MCP server (`buy mcp serve`) is the defendant's wallet. Its tools
 * are bridged one to one into the model's tool list. buy_send is never
 * exposed: the agent pays for things, it does not transfer money around.
 */
const ALLOWED = ['buy_whoami', 'buy_balance', 'buy_discover', 'buy_pay_quote', 'buy_curl', 'buy_verify_status'];
const PAYING = new Set(['buy_curl']);
const DEFAULT_TOKEN = 'USDT';
/**
 * Hard ceiling per paid call. AGENT_MAX_AMOUNT is in USD₮; buy_curl takes it in
 * the token's smallest unit (6 decimals), so 0.05 goes out as "50000". The system
 * prompt says the same; this one the model cannot talk its way past.
 */
const MAX_AMOUNT = parseUnits(process.env.AGENT_MAX_AMOUNT ?? '0.05', DEMO_TOKEN.decimals).toString();

let client: Client | null = null;

export async function connectBuy(): Promise<Client> {
  if (client) return client;
  const { command, args, env } = mcpServeCommand();
  const transport = new StdioClientTransport({ command, args, env: env as Record<string, string>, stderr: 'pipe' });
  const c = new Client({ name: 'agent-on-trial', version: '0.1.0' });
  await c.connect(transport);
  client = c;
  log.ops(`connected to buy MCP (${command.split('/').pop()} ${args.join(' ')})`);
  return c;
}

export async function disconnectBuy() {
  if (client) {
    await client.close().catch(() => undefined);
    client = null;
  }
}

type JsonSchemaParam = Parameters<typeof betaTool>[0]['inputSchema'];

interface McpTool {
  name: string;
  description?: string;
  inputSchema: JsonSchemaParam & { properties?: Record<string, unknown> };
}

export async function buyTools(ctx: ActContext) {
  if (env.dryRun) return dryRunBuyTools(ctx) as unknown as ReturnType<typeof betaTool>[];
  const c = await connectBuy();
  const { tools } = (await c.listTools()) as { tools: McpTool[] };
  const names = tools.map((t) => t.name);
  const missing = ALLOWED.filter((n) => !names.includes(n));
  if (missing.length) log.warn(`buy MCP does not expose: ${missing.join(', ')}`);

  return tools
    .filter((t) => ALLOWED.includes(t.name))
    .map((t) => {
      const hasToken = Boolean(t.inputSchema.properties && 'token' in t.inputSchema.properties);
      return betaTool({
        name: t.name,
        description: `${t.description ?? ''}${hasToken ? ' Always pass token USDT.' : ''}`.trim(),
        inputSchema: t.inputSchema,
        run: async (input: Record<string, unknown>) => {
          const hasMax = Boolean(t.inputSchema.properties && 'maxAmount' in t.inputSchema.properties);
          const args: Record<string, unknown> = { ...(hasToken ? { token: DEFAULT_TOKEN } : {}), ...input, ...(hasMax ? { maxAmount: MAX_AMOUNT } : {}) };
          log.toolCall(t.name, args);
          if (PAYING.has(t.name)) {
            const target = typeof args.url === 'string' ? args.url : JSON.stringify(args).slice(0, 80);
            if (!(await approve(`${t.name} pays for ${target}`))) return 'The host declined this payment. Do not retry it.';
          }
          const since = Date.now() - 1000;
          const res = (await c.callTool({ name: t.name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
          const text = (res.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
          if (PAYING.has(t.name)) {
            const url = typeof args.url === 'string' ? args.url : '';
            ctx.artifacts.push({ kind: 'x402_response', url, body: text });
            for (const r of receiptsSince(since)) {
              ctx.artifacts.push({ kind: 'x402_receipt', url: r.url, txHash: r.txHash, amount: r.amount, asset: r.asset, network: r.network, raw: r as unknown as Record<string, unknown> });
              if (r.txHash) log.tx(`x402 settled ${paidAmount(r.amount, r.asset).label} for ${r.url}`, r.txHash);
            }
          }
          log.toolResult(t.name, res.isError ? `error: ${text}` : t.name === 'buy_pay_quote' ? quoteLine(text) : text);
          return res.isError ? `error: ${text}` : text;
        },
      });
    });
}

/** buy calls a quote a "DRY RUN" (nothing is signed); on the live log it reads as the price and who would be paid. */
function quoteLine(text: string): string {
  try {
    const q = JSON.parse(text.slice(text.indexOf('{'))) as { price?: { formatted?: string; atomic?: string }; payTo?: string; description?: string };
    return `quote: ${q.price?.formatted ?? q.price?.atomic ?? '?'} to ${q.payTo ?? '?'}${q.description ? ` · ${q.description}` : ''}`;
  } catch {
    return text;
  }
}
