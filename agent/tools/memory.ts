import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { canonicalJson } from '@trial/shared';
import { z } from 'zod';
import { getStorage, NotImplemented } from '../../adapters/storage/index.js';
import type { StoredRef } from '../../adapters/storage/types.js';
import { log, showUri } from '../../lib/log.js';
import type { ActContext } from '../context.js';

export interface MemoryEntry {
  at: string;
  act?: string;
  text: string;
  txHash?: string;
}

/**
 * The agent's memory: an append-only list, stored as one document through the
 * storage adapter after every write. The head pointer goes to a feed when the
 * adapter has one, else to a local pointer file. Whoever holds the latest
 * reference can read everything the agent remembers.
 */
export class Memory {
  entries: MemoryEntry[] = [];
  head: StoredRef | null = null;
  private readonly path: string;

  constructor(
    readonly agentId: string | undefined,
    readonly runId: string,
  ) {
    this.path = `.runs/${runId}/memory.json`;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { entries: MemoryEntry[]; head: StoredRef | null };
      this.entries = parsed.entries ?? [];
      this.head = parsed.head ?? null;
    } catch {
      /* fresh */
    }
  }

  document() {
    return {
      type: 'agent-on-trial/memory-v1',
      agentId: this.agentId ?? null,
      runId: this.runId,
      updatedAt: new Date().toISOString(),
      entries: this.entries,
    };
  }

  async write(entry: Omit<MemoryEntry, 'at'>): Promise<StoredRef> {
    this.entries.push({ at: new Date().toISOString(), ...entry });
    const storage = getStorage();
    const ref = await storage.put(canonicalJson(this.document()), { contentType: 'application/json', name: 'memory.json' });
    this.head = ref;
    try {
      await storage.feedUpdate(`agent-memory-${this.agentId ?? 'unregistered'}`, ref.uri);
    } catch (err) {
      if (!(err instanceof NotImplemented)) throw err;
    }
    mkdirSync(`.runs/${this.runId}`, { recursive: true });
    writeFileSync(this.path, JSON.stringify({ entries: this.entries, head: this.head }, null, 2));
    return ref;
  }
}

export function memoryTools(ctx: ActContext, act?: string) {
  const memory_read = betaZodTool({
    name: 'memory_read',
    description: 'Read your own memory: every entry you wrote so far in this run, and where the latest copy is stored.',
    inputSchema: z.object({}),
    run: async () => {
      log.toolCall('memory_read', {});
      const out = { head: ctx.memory.head, entries: ctx.memory.entries };
      log.toolResult('memory_read', `${ctx.memory.entries.length} entries`);
      return JSON.stringify(out);
    },
  });

  const memory_write = betaZodTool({
    name: 'memory_write',
    description: 'Append one entry to your memory and store the whole memory where anyone can verify it. Returns the storage reference and hash.',
    inputSchema: z.object({
      text: z.string().min(1).max(1000).describe('What happened, why, in one to three sentences.'),
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe('The transaction this entry is about, if any.'),
    }),
    run: async ({ text, txHash }) => {
      log.toolCall('memory_write', { text, txHash });
      const ref = await ctx.memory.write({ text, txHash, act });
      ctx.artifacts.push({ kind: 'memory', uri: ref.uri, hash: ref.hash, gatewayUrl: ref.gatewayUrl, entries: ctx.memory.entries.length });
      log.toolResult('memory_write', `stored ${showUri(ref.uri, ref.gatewayUrl)} hash ${ref.hash}`);
      return JSON.stringify({ stored: ref.uri, hash: ref.hash, gatewayUrl: ref.gatewayUrl, entries: ctx.memory.entries.length });
    },
  });

  return [memory_read, memory_write];
}
