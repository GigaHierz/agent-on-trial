import { pathToFileURL } from 'node:url';
import { ACT_PROMPTS } from '../agent/acts.js';
import { Memory } from '../agent/tools/memory.js';
import type { ActContext } from '../agent/context.js';
import { disconnectBuy } from '../agent/tools/buy-mcp.js';
import { env } from '../lib/env.js';
import { EvidenceStore } from '../lib/evidence.js';
import { flushLog, log } from '../lib/log.js';

/** True when this file is the entry point (pnpm act:*), false when imported by the session. */
export function isMain(url: string): boolean {
  return Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;
}

export function makeCtx(): ActContext {
  const evidence = EvidenceStore.load();
  return { evidence, memory: new Memory(evidence.data.agentId, evidence.runId), artifacts: [], params: {} };
}

/** Run one act as a script: build the context, run, flush, exit. */
export async function asScript(name: string, fn: (ctx: ActContext) => Promise<unknown>) {
  if (env.dryRun && name !== 'dispute' && name !== 'ruling') {
    console.error(`--dry-run rehearses act dispute and act ruling only; act ${name} would move money or sign on Celo`);
    process.exit(1);
  }
  const ctx = makeCtx();
  // The chat shows the act as the host's turn, same as /act in the session.
  if (ACT_PROMPTS[name]) log.prompt(ACT_PROMPTS[name]);
  log.ops(`act ${name} · run ${ctx.evidence.runId} · round ${ctx.evidence.data.round}`);
  try {
    await fn(ctx);
    await disconnectBuy();
    await flushLog();
    process.exit(0);
  } catch (err) {
    log.error((err as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(err));
    await disconnectBuy();
    await flushLog();
    process.exit(1);
  }
}
