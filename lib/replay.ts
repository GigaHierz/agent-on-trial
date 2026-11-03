import { existsSync, readFileSync } from 'node:fs';
import type { LogLine } from '@trial/shared';
import { log } from './log.js';

export const FIXTURE_LOG_FILE = 'evidence/fixture-log.json';

export interface FixtureLog {
  recordedAt?: string;
  round?: string;
  acts: Record<string, LogLine[]>;
}

/** The recorded conversation of a rehearsal, one list of log lines per act. `pnpm record:log` writes it. */
export function loadFixtureLog(): FixtureLog | null {
  if (!existsSync(FIXTURE_LOG_FILE)) return null;
  return JSON.parse(readFileSync(FIXTURE_LOG_FILE, 'utf8')) as FixtureLog;
}

export function hasRecordedLog(act: string): boolean {
  return (loadFixtureLog()?.acts[act]?.length ?? 0) > 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Replays the recorded lines of one act into the terminal and the courtroom,
 * paced like a live run, so the chat reads as a conversation. The host's
 * prompt is skipped: the session has already printed the live one.
 */
export async function replayLog(act: string, opts: { pace?: number } = {}): Promise<number> {
  const lines = loadFixtureLog()?.acts[act] ?? [];
  const pace = opts.pace ?? 1;
  let n = 0;
  for (const line of lines) {
    if (line.kind === 'host' && line.data?.prompt) continue;
    log.replay(line);
    n++;
    const wait = line.kind === 'agent' ? 900 : line.kind === 'tx' ? 700 : line.kind === 'tool_call' ? 500 : 250;
    await sleep(wait * pace);
  }
  return n;
}
