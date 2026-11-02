import type { Evidence, LogLine } from '@trial/shared';
import { env } from './env.js';

/**
 * The terminal is the source of truth; the courtroom mirrors it. Every call
 * here is best effort: a dead courtroom must never stop the show.
 */
function enabled(): boolean {
  // TRIAL_PUBLISH=0 keeps setup scripts (preflight, shady:register) out of the public log.
  return process.env.TRIAL_PUBLISH !== '0' && Boolean(env.courtroomUrl && env.hostSecret);
}

async function post(path: string, body: unknown): Promise<boolean> {
  if (!enabled()) return false;
  try {
    const res = await fetch(`${env.courtroomUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-secret': env.hostSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const publish = {
  enabled,
  evidence: (evidence: Evidence) => post('/api/evidence', evidence),
  log: (round: string, lines: LogLine[]) => post('/api/log', { round, lines }),
  round: (round: string, action: 'open' | 'close' | 'reset' | 'current', extra: Record<string, unknown> = {}) =>
    post('/api/vote/round', { round, action, ...extra }),
  async tally(round: string) {
    if (!env.courtroomUrl) return null;
    try {
      const res = await fetch(`${env.courtroomUrl}/api/vote/tally?round=${encodeURIComponent(round)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return (await res.json()) as { round: string; trust: number; distrust: number; voters: number; open: boolean; closedAt?: string };
    } catch {
      return null;
    }
  },
};
