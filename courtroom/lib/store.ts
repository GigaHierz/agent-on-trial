import { Evidence, LogLine, type VoteTally } from '@trial/shared';
import { DEFAULT_ROUND, K, LOG_CAP, RoundId } from './keys';
import { requireRedis } from './redis';

export async function currentRound(): Promise<string> {
  // Upstash deserializes values that look like JSON, so a numeric round comes back as a number.
  const v = await requireRedis().get<string | number>(K.round);
  return v === null || v === undefined ? DEFAULT_ROUND : String(v);
}

export async function setCurrentRound(round: string): Promise<void> {
  await requireRedis().set(K.round, round);
}

export function roundParam(req: Request, name = 'round'): string | null {
  const r = new URL(req.url).searchParams.get(name);
  return r && RoundId.safeParse(r).success ? r : null;
}

export async function resolveRound(req: Request): Promise<string> {
  return roundParam(req) ?? (await currentRound());
}

export async function getEvidence(round: string): Promise<Evidence | null> {
  const raw = await requireRedis().get<unknown>(K.evidence(round));
  if (raw === null || raw === undefined) return null;
  const parsed = Evidence.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  return parsed.success ? parsed.data : null;
}

export async function setEvidence(evidence: Evidence): Promise<void> {
  const r = requireRedis();
  await r.set(K.evidence(evidence.round), JSON.stringify(evidence));
  if (evidence.agentId) await r.set(K.agentId, evidence.agentId);
}

export async function getAgentId(): Promise<string | null> {
  const v = await requireRedis().get<string | number>(K.agentId);
  return v === null || v === undefined ? null : String(v);
}

export async function appendLog(round: string, lines: LogLine[]): Promise<number> {
  if (lines.length === 0) return 0;
  const r = requireRedis();
  const key = K.log(round);
  const len = await r.rpush(key, ...lines.map((l) => JSON.stringify(l)));
  await r.ltrim(key, -LOG_CAP, -1);
  return len;
}

function parseLine(raw: unknown): LogLine | null {
  const parsed = LogLine.safeParse(typeof raw === 'string' ? safeJson(raw) : raw);
  return parsed.success ? parsed.data : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function readLog(round: string, after: number): Promise<{ lines: LogLine[]; next: number; reset?: true }> {
  const r = requireRedis();
  const raw = await r.lrange<unknown>(K.log(round), after, -1);
  // A cleared log is shorter than the reader's cursor: hand it the log from the top, and say so.
  if (raw.length === 0 && after > 0 && (await r.lrange<unknown>(K.log(round), after - 1, after - 1)).length === 0) {
    const all = await r.lrange<unknown>(K.log(round), 0, -1);
    return { lines: all.map(parseLine).filter((l): l is LogLine => l !== null), next: all.length, reset: true };
  }
  const lines = raw.map(parseLine).filter((l): l is LogLine => l !== null);
  return { lines, next: after + raw.length };
}

export async function readLogTail(round: string, n: number): Promise<LogLine[]> {
  const raw = await requireRedis().lrange<unknown>(K.log(round), -n, -1);
  return raw.map(parseLine).filter((l): l is LogLine => l !== null);
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function getTally(round: string): Promise<VoteTally> {
  const p = requireRedis().pipeline();
  p.hgetall(K.tally(round));
  p.scard(K.voters(round));
  p.get(K.voteOpen(round));
  p.get(K.voteClosedAt(round));
  const [hash, voters, open, closedAt] = await p.exec<
    [Record<string, unknown> | null, number, string | number | null, string | null]
  >();
  return {
    round,
    trust: toInt(hash?.trust),
    distrust: toInt(hash?.distrust),
    voters: toInt(voters),
    open: String(open) === '1',
    ...(closedAt ? { closedAt: String(closedAt) } : {}),
  };
}

export async function getStatements(round: string): Promise<{ prosecutor?: string; defense?: string }> {
  const h = await requireRedis().hgetall<Record<string, string>>(K.statements(round));
  return { prosecutor: h?.prosecutor, defense: h?.defense };
}
