import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { env } from './env.js';

/**
 * askbots.ai from the agent's side. The REST surface is documented at
 * https://askbots.ai/skill.md. Only what the trial needs is here.
 */
export interface AskbotsCreds {
  apiKey: string;
  /** The askbots user (account) id. Needed for the ERC-8004 link message. */
  agentId: string;
  name?: string;
}

export interface AskbotsProject {
  id?: string;
  _id?: string;
  name: string;
  propertyType: string;
  propertyUrl: string;
  questions: Array<{ id: string; type: string; text?: string; question?: string; options?: string[]; choices?: string[] }>;
  evaluationGuidance?: string[];
  [k: string]: unknown;
}

export type VerifyOutcome =
  | { outcome: 'paid'; txHash: string; payout: string; currency: string; responseId?: string }
  | { outcome: 'accepted-unpaid'; responseId?: string }
  | { outcome: 'accepted-payout-failed'; reason: string; responseId?: string }
  | { outcome: 'challenge-failed'; reason: string };

export class AskbotsClient {
  constructor(
    private readonly base = env.askbotsUrl,
    private apiKey: string | null = null,
  ) {}

  setApiKey(key: string) {
    this.apiKey = key;
  }

  async api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; ok: boolean; body: T | null }> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, ok: res.ok, body };
  }

  /** Creates a real bot user on askbots. Never automatic. */
  async register(name: string, description: string): Promise<AskbotsCreds> {
    const r = await this.api<{ apiKey: string; agentId: string }>('/api/auth/openclaw', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
    if (!r.ok || !r.body?.apiKey) throw new Error(`askbots registration failed (${r.status}): ${JSON.stringify(r.body)}`);
    this.apiKey = r.body.apiKey;
    return { apiKey: r.body.apiKey, agentId: r.body.agentId, name };
  }

  /** GET /api/auth/openclaw with the key returns the account id. */
  async account() {
    return this.api<{ agentId: string; name?: string; status?: string }>('/api/auth/openclaw');
  }

  async me() {
    return this.api<{
      profileId?: string;
      botName?: string;
      celoAddress?: string;
      erc8004AgentId?: string;
      rating?: number;
      totalReviews?: number;
    }>('/api/bot-profiles/me');
  }

  async createProfile(p: {
    botName: string;
    country: string;
    skills: string[];
    celoAddress: string;
    erc8004AgentId: string;
    erc8004Signature: string;
  }) {
    return this.api<{ profileId?: string; error?: string }>('/api/bot-profiles', { method: 'POST', body: JSON.stringify(p) });
  }

  async listProjects(): Promise<AskbotsProject[]> {
    const r = await this.api<{ projects: AskbotsProject[] }>('/api/projects');
    if (!r.ok) throw new Error(`GET /api/projects ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body?.projects ?? [];
  }

  async history() {
    return this.api<{
      summary: { totalResponses: number; paidResponses: number; earningsUsdt: number; positiveRatings: number; negativeRatings: number };
      projects: unknown[];
    }>('/api/bot-profiles/me/history');
  }

  async respond(projectId: string, answers: Array<{ questionId: string; answer: string }>) {
    return this.api<{ challengeId?: string; prompt?: string; timeoutMs?: number; error?: string; flags?: string[] }>(
      `/api/projects/${projectId}/respond`,
      { method: 'POST', body: JSON.stringify({ answers }) },
    );
  }

  async verifyChallenge(projectId: string, challengeId: string, answer: string) {
    return this.api<{
      passed?: boolean;
      paid?: boolean;
      txHash?: string;
      payoutTxHash?: string;
      payout?: string;
      currency?: string;
      responseId?: string;
      error?: string;
      reason?: string;
    }>(`/api/projects/${projectId}/verify-challenge`, { method: 'POST', body: JSON.stringify({ challengeId, answer }) });
  }

  /**
   * respond + verify-challenge inside the 2 s window. The LLM composes the
   * answers before this is called; nothing slow happens between the two calls.
   */
  async submitReview(projectId: string, answers: Array<{ questionId: string; answer: string }>): Promise<
    VerifyOutcome | { outcome: 'rejected' | 'duplicate' | 'excluded' | 'daily-cap' | 'error'; status: number; detail: string }
  > {
    const submitted = await this.respond(projectId, answers);
    if (submitted.status === 409) return { outcome: 'duplicate', status: 409, detail: 'already reviewed this project' };
    if (submitted.status === 403) return { outcome: 'excluded', status: 403, detail: JSON.stringify(submitted.body) };
    if (submitted.status === 429) return { outcome: 'daily-cap', status: 429, detail: submitted.body?.error ?? 'daily cap' };
    if (submitted.status === 422) return { outcome: 'rejected', status: 422, detail: submitted.body?.error ?? (submitted.body?.flags ?? []).join(', ') };
    if (!submitted.ok || !submitted.body?.challengeId || !submitted.body.prompt) {
      return { outcome: 'error', status: submitted.status, detail: JSON.stringify(submitted.body).slice(0, 200) };
    }
    const answer = solveChallenge(submitted.body.prompt);
    const v = await this.verifyChallenge(projectId, submitted.body.challengeId, answer);
    return classifyVerify(v.status, v.body ?? {});
  }
}

/** Mirrors the server's own arithmetic; it compares the result as a string. */
export function solveChallenge(prompt: string): string {
  let m: RegExpMatchArray | null;
  if ((m = prompt.match(/^What is (\d+) \* (\d+) \+ (\d+)\?$/))) return String(BigInt(m[1]) * BigInt(m[2]) + BigInt(m[3]));
  if ((m = prompt.match(/^What is \((\d+) \+ (\d+)\) \* (\d+)\?$/))) return String((BigInt(m[1]) + BigInt(m[2])) * BigInt(m[3]));
  if ((m = prompt.match(/^What is (\d+) \* (\d+) - (\d+)\?$/))) return String(BigInt(m[1]) * BigInt(m[2]) - BigInt(m[3]));
  throw new Error(`unrecognised challenge: ${JSON.stringify(prompt)}`);
}

/** Only `paid === true` is a payout. A 202 carries passed:true and no money. */
export function classifyVerify(
  status: number,
  body: { passed?: boolean; paid?: boolean; txHash?: string; payoutTxHash?: string; payout?: string; currency?: string; responseId?: string; error?: string; reason?: string },
): VerifyOutcome {
  if (!body.passed) return { outcome: 'challenge-failed', reason: body.error ?? body.reason ?? `status ${status}` };
  if (status === 202) return { outcome: 'accepted-payout-failed', reason: body.error ?? 'payout failed; server retries', responseId: body.responseId };
  const tx = body.txHash ?? body.payoutTxHash;
  if (body.paid === true && tx) {
    return { outcome: 'paid', txHash: tx, payout: body.payout ?? '0.10', currency: body.currency ?? 'USDT', responseId: body.responseId };
  }
  return { outcome: 'accepted-unpaid', responseId: body.responseId };
}

export function projectIdOf(p: AskbotsProject): string {
  const id = p.id ?? p._id;
  if (!id) throw new Error('project without id');
  return id;
}

export async function loadCreds(path = env.askbotsCreds): Promise<AskbotsCreds | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as AskbotsCreds;
    return parsed.apiKey ? parsed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveCreds(creds: AskbotsCreds, path = env.askbotsCreds) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2) + '\n');
  try {
    await chmod(path, 0o600);
  } catch {
    /* non-POSIX */
  }
}

/** Byte-identical to askbots' server-side message. */
export function erc8004LinkMessage(p: { agentId: string; chainId: number; userId: string; wallet: string }): string {
  return `AskBots: link ERC-8004 agent ${p.agentId} on chain ${p.chainId} to AskBots account ${p.userId} (wallet ${p.wallet})`;
}
