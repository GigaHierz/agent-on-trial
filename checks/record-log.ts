import { writeFileSync } from 'node:fs';
import type { LogLine } from '@trial/shared';
import { ACT_PROMPTS } from '../agent/acts.js';
import { env } from '../lib/env.js';
import { FIXTURE_LOG_FILE } from '../lib/replay.js';

/**
 * pnpm record:log [--round <id>]
 *
 * Freezes a rehearsal's conversation: reads the courtroom's live log for the
 * round, splits it at the host's prompts into acts, keeps the first run of
 * each act, and writes evidence/fixture-log.json. Together with
 * evidence/fixtures.json (the exhibits) it lets `pnpm trial --step` replay an
 * act that fails on stage.
 */
async function main() {
  if (!env.courtroomUrl) throw new Error('COURTROOM_URL unset');
  const round = env.round;
  const res = await fetch(`${env.courtroomUrl}/api/log?round=${encodeURIComponent(round)}&after=0`);
  if (!res.ok) throw new Error(`GET /api/log ${res.status}`);
  const { lines } = (await res.json()) as { lines: LogLine[] };

  const byPrompt = new Map(Object.entries(ACT_PROMPTS).map(([act, text]) => [text, act]));
  const acts: Record<string, LogLine[]> = {};
  let current: string | null = null;
  let skipping = false;
  for (const line of lines) {
    if (line.kind === 'host' && line.data?.prompt) {
      const act = byPrompt.get(line.text) ?? null;
      current = act;
      skipping = act !== null && act in acts; // a second run of the same act: keep the first
      if (act && !skipping) acts[act] = [];
    }
    if (!current || skipping) continue;
    // Operator-only kinds never reach the log; errors from a failed attempt do, and a replay must not repeat them.
    if (line.kind === 'error') continue;
    acts[current].push(line);
  }

  const summary = Object.entries(acts).map(([a, l]) => `${a} ${l.length}`).join(', ');
  writeFileSync(FIXTURE_LOG_FILE, JSON.stringify({ recordedAt: new Date().toISOString(), round, acts }, null, 2) + '\n');
  console.log(`recorded ${lines.length} lines from round ${round} into ${FIXTURE_LOG_FILE}: ${summary}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
