import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';
import { ACTS, type ActName } from './acts.js';
import type { ActContext } from './context.js';
import { AskbotsClient } from '../lib/askbots.js';
import { askbotsTools } from './tools/askbots.js';
import { buyTools } from './tools/buy-mcp.js';
import { disputeTools } from './tools/dispute.js';
import { memoryTools } from './tools/memory.js';
import { reputationTools } from './tools/reputation.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SYSTEM = readFileSync(join(here, 'system.md'), 'utf8');

const MAX_ITERATIONS = 12;

let anthropic: Anthropic | null = null;
export function claude(): Anthropic {
  return (anthropic ??= new Anthropic());
}

export type AnyTool = BetaRunnableTool<any>;

/**
 * Every tool the defendant can ever use, built once per context. Acts pick a
 * subset by name; the free-text session gets the union.
 */
export async function allTools(ctx: ActContext, askbots: AskbotsClient | null, act?: ActName): Promise<AnyTool[]> {
  const tools: AnyTool[] = [...memoryTools(ctx, act), ...reputationTools(), ...disputeTools(ctx)];
  if (askbots && !env.dryRun) tools.push(...askbotsTools(ctx, askbots)); // askbots is a live service: not in a rehearsal
  try {
    tools.push(...(await buyTools(ctx)));
  } catch (err) {
    log.warn(`buy MCP unavailable: ${(err as Error).message.split('\n')[0]}`);
  }
  return tools;
}

export interface TurnOptions {
  ctx: ActContext;
  tools: AnyTool[];
  /** Conversation so far; the turn appends to it. */
  messages: Anthropic.Beta.BetaMessageParam[];
  userText: string;
}

/**
 * One agent turn: the model runs tools until it stops. Each assistant message
 * is printed as it lands, so the audience sees the agent think out loud.
 */
export async function runTurn(o: TurnOptions): Promise<string> {
  o.messages.push({ role: 'user', content: o.userText });
  const runner = claude().beta.messages.toolRunner({
    model: env.anthropicModel,
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: o.tools,
    messages: o.messages,
    max_iterations: MAX_ITERATIONS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });

  let lastText = '';
  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) {
        lastText = block.text.trim();
        for (const line of lastText.split('\n')) if (line.trim()) log.agent(line.trim());
      }
    }
    if (message.stop_reason === 'refusal') {
      log.warn('the model declined to continue this turn');
      break;
    }
    if (message.stop_reason === 'max_tokens') {
      log.warn('the model hit max_tokens; stopping this turn');
      break;
    }
  }
  const final = await runner.done();
  // Keep the whole exchange so the next host message continues the conversation.
  const params = runner.params;
  o.messages.length = 0;
  o.messages.push(...params.messages);
  if (final && !params.messages.some((m) => m.role === 'assistant' && m.content === final.content)) {
    o.messages.push({ role: 'assistant', content: final.content });
  }
  return lastText;
}

/** Run one scripted act with its tool allowlist. */
export async function runAct(ctx: ActContext, act: ActName, askbots: AskbotsClient | null, messages: Anthropic.Beta.BetaMessageParam[] = []): Promise<string> {
  const spec = ACTS[act];
  const tools = (await allTools(ctx, askbots, act)).filter((t) => spec.tools.includes(t.name));
  const missing = spec.tools.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length) log.warn(`act ${act} is missing tools: ${missing.join(', ')}`);
  log.host(`act ${act}: ${spec.task(ctx.params).split('\n')[0]}`);
  if (act === 'dispute' && (env.scriptedAgent || (env.dryRun && !process.env.ANTHROPIC_API_KEY))) return scriptedDisputeTurn(ctx, tools);
  return runTurn({ ctx, tools, messages, userText: spec.task(ctx.params) });
}

/**
 * --scripted-agent, or --dry-run with no ANTHROPIC_API_KEY: act 4's turn played by a script that calls the act's own tools in
 * the order the task asks for, so the dispute path can be rehearsed before the key is in. With the key,
 * the model plays it.
 */
async function scriptedDisputeTurn(ctx: ActContext, tools: AnyTool[]): Promise<string> {
  log.opsWarn(`${env.scriptedAgent ? '--scripted-agent' : 'dry run: no ANTHROPIC_API_KEY, so'}: the agent's turn is played by a script (the same tools, in the order the task asks; no model)`);
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name) as { run: (i: unknown) => unknown } | undefined;
    if (!tool) throw new Error(`act dispute has no ${name} tool`);
    const out = await tool.run(input);
    return typeof out === 'string' ? out : JSON.stringify(out);
  };
  const url = ctx.params.shadyUrl ?? 'http://localhost:4402/report/celo';
  if (ctx.params.shadyAgentId) {
    const rep = JSON.parse(await call('check_reputation', { agentId: ctx.params.shadyAgentId })) as { summaries?: { tag1: string; count: number; value: number }[]; error?: string };
    const seen = (rep.summaries ?? []).filter((s) => s.count > 0).map((s) => `${s.count} ${s.tag1} (avg ${s.value})`).join(', ');
    log.agent(`Provider ${ctx.params.shadyAgentId} on ERC-8004: ${seen || 'no feedback yet'}.`);
  }
  log.agent('Getting a quote.');
  await call('buy_pay_quote', { url, token: 'USDT' });
  const paid = await call('buy_curl', { url, token: 'USDT' });
  const body = paid.split('--- response body ---\n')[1] ?? '';
  const receipt = paid.match(/tx=(0x[0-9a-fA-F]{64})/)?.[1];
  if (!receipt) return 'the purchase did not settle';
  log.agent('The report has none of the advertised sections: no price, no volume, no sources. Opening a dispute.');
  const opened = await call('open_dispute', {
    providerAgentId: ctx.params.shadyAgentId,
    providerEndpoint: url,
    receiptTxHash: receipt,
    expected: 'a Celo market report with sections: price, volume, sources',
    deliveredBody: body,
    claim: 'I paid 0.01 USD₮ for a Celo market report advertised with three sections: price, volume and sources. What came back is one sentence of opinion with none of them: no price, no volume, no source. The delivery does not match what was advertised.',
  });
  await call('memory_write', { text: 'Bought a market report from an unrated provider; it had none of the advertised sections, so I opened a dispute.', txHash: receipt });
  return opened;
}
