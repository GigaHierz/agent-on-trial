/**
 * Client for the Kleros Dispute Service: Kleros v2 disputes through one
 * authenticated MCP endpoint, called as plain JSON-RPC over HTTP.
 * https://docs.kleros.io/ai-tools/dispute-service/overview
 *
 * Wire rules this file encodes (the service's HTTP JSON-RPC guide):
 * - one request per POST, no session, never a batch;
 * - Accept names both application/json and text/event-stream, or the call is a 406;
 * - a 200 is SSE framed ("data: {...}"); 400/401/413/429 are plain JSON and
 *   are decided before the tool runs, so nothing was sent;
 * - a failed tool call is isError: true plus prose "CODE: message", no code field;
 * - 30 requests a minute per key, and a 429 carries no Retry-After;
 * - dispute_create, evidence_pin and evidence_submit run one at a time per key:
 *   a second write comes back WRITE_IN_PROGRESS, nothing sent, safe to repeat.
 */

export const DEFAULT_SERVICE_URL = 'https://kleros-dispute-service.fly.dev/mcp';

/** The two Kleros v2 deployments that file disputes. "Beta" is live production, not a test network. */
export const KLEROS_CHAINS = ['arbitrum-sepolia-testnet', 'arbitrum-one'] as const;
export type KlerosChain = (typeof KLEROS_CHAINS)[number];

export interface ServiceDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ServiceOptions extends ServiceDeps {
  url: string;
  apiKey: string;
  /** Spacing between requests: 30 a minute per key is one every 2 s. */
  minIntervalMs?: number;
  readTimeoutMs?: number;
  /** dispute_create stops itself after three minutes (FILING_TIMED_OUT); wait a little longer. */
  writeTimeoutMs?: number;
}

/** A non-2xx HTTP answer. 400, 401, 406, 413 and 429 are decided before any tool runs. */
export class ServiceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Kleros Dispute Service HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'ServiceHttpError';
  }

  /** True when the service refused the request before it reached a tool. */
  get notSent(): boolean {
    return [400, 401, 406, 413, 429].includes(this.status);
  }
}

/** A JSON-RPC error, e.g. -32601 when a write tool is not in this key's tools/list. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`Kleros Dispute Service JSON-RPC ${code}: ${message}`);
    this.name = 'RpcError';
  }
}

/**
 * The refusals that, per the service's docs, sent nothing. The lists are
 * closed: any other code, a code the docs never named, or prose with no code
 * is "in doubt" (it may have been sent), never assumed safe.
 * https://docs.kleros.io/ai-tools/dispute-service/dispute-flow#when-something-goes-wrong
 */
const NOT_SENT: Record<string, ReadonlySet<string>> = {
  dispute_create: new Set([
    'WRITE_IN_PROGRESS', 'INSUFFICIENT_BALANCE', 'COST_CEILING_EXCEEDED', 'ZERO_ADDRESS_ALIAS', 'ALIASES_REQUIRED',
    'UNKNOWN_ALIAS_SLOT', 'INVALID_ALIASES', 'TEMPLATE_INVALID', 'POLICY_URI_INVALID', 'RULING_OPTIONS_INVALID',
    'COURT_OUT_OF_RANGE', 'JURORS_INVALID', 'CHAIN_NOT_SUPPORTED', 'UNKNOWN', 'VALIDATION_ERROR', 'KEY_FILE_MISSING',
    'KEY_FILE_PERMISSIONS',
  ]),
  evidence_pin: new Set(['WRITE_IN_PROGRESS', 'ATTACHMENT_INVALID', 'EXTENSION_INVALID', 'FILE_UNREADABLE', 'FILE_EMPTY', 'FILE_TOO_LARGE', 'UNKNOWN', 'VALIDATION_ERROR']),
  evidence_submit: new Set([
    'WRITE_IN_PROGRESS', 'DISPUTE_INVALID', 'NAME_INVALID', 'DESCRIPTION_INVALID', 'FILE_URI_INVALID', 'EXTENSION_INVALID',
    'EVIDENCE_INVALID', 'DISPUTE_NOT_FOUND', 'DISPUTE_NOT_ADDRESSABLE', 'SIMULATION_REVERTED', 'INSUFFICIENT_BALANCE',
    'WRONG_CHAIN', 'NUMBER_INVALID', 'CHAIN_NOT_SUPPORTED', 'UNKNOWN', 'VALIDATION_ERROR', 'KEY_FILE_MISSING',
    'KEY_FILE_PERMISSIONS', 'KEY_FILE_UNREADABLE', 'KEY_FILE_INVALID',
  ]),
};

/**
 * not-sent: refused before anything left. reverted: mined and failed, the
 * outcome is known (no dispute, no document) but a human reads why before
 * anyone tries again. in-doubt: it may have been sent; treat like status unknown.
 */
export type Outcome = 'not-sent' | 'reverted' | 'in-doubt';

export function classify(tool: string, code: string | undefined): Outcome {
  const safe = NOT_SENT[tool];
  if (!safe) return 'not-sent'; // reads send nothing
  if (code === 'TRANSACTION_REVERTED') return 'reverted';
  return code && safe.has(code) ? 'not-sent' : 'in-doubt';
}

/** A tool refusal (isError: true). The code, when there is one, is read from the prose. */
export class ToolError extends Error {
  readonly code?: string;
  readonly outcome: Outcome;
  /** The first transaction hash in the text, if any (TRANSACTION_REVERTED carries one). */
  readonly txHash?: string;

  constructor(
    readonly tool: string,
    readonly text: string,
    outcome?: Outcome,
  ) {
    super(`${tool}: ${text.split('\n')[0].slice(0, 300)}`);
    this.name = 'ToolError';
    this.code = errorCode(text);
    this.outcome = outcome ?? classify(tool, this.code);
    this.txHash = text.match(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/)?.[0];
  }

  /** It may have been sent: handle it exactly like status unknown. */
  get maybeSent(): boolean {
    return this.outcome === 'in-doubt';
  }
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { properties?: Record<string, unknown> } & Record<string, unknown>>; required?: string[] };
}

type Json = Record<string, unknown>;

/** dispute_create and evidence_submit. There is no "reverted": that arrives as TRANSACTION_REVERTED. */
export interface WriteOutcome {
  status: 'simulated' | 'mined' | 'unknown';
  /** The deployment the service says it used, when the payload names one. */
  chain?: string;
  txHash?: string;
  /** dispute_create, mined only: the id Kleros Court shows and every read takes. */
  coreDisputeID?: string;
  /** dispute_create, mined only: the arbitrable's own id, the one evidence_list takes. */
  localDisputeID?: string;
  localDisputeIDUnavailable?: string;
  raw: Json;
}

export interface PinOutcome {
  status: 'checked' | 'published';
  /** /ipfs/<cid>, published only. */
  fileURI?: string;
  cid?: string;
  raw: Json;
}

/** One row of dispute_get. Read live from the arbitrator on every call. */
export interface DisputeRow {
  id: string;
  status: 'Evidence' | 'Commit' | 'Vote' | 'Appeal' | 'Executed' | string;
  /** The current winning option as a string, "0" while tied. */
  ruling: string | null;
  /** No option leads yet. What makes ruling "0" readable. */
  tied?: boolean;
  ruled?: boolean;
  ruledSemantics?: string;
  rulingLabel?: string | null;
  rulingOptions?: { value: number; title: string }[] | null;
  roundCount?: number;
  /** The current round: how many jurors were drawn for it. */
  round?: { id?: string; jurorCount?: number } | null;
  court?: string;
  deadline?: string | null;
  lastPeriodChange?: string;
  overridden?: boolean;
  chain?: string;
  unresolvedFields?: string[];
  unresolvedReason?: string;
  [key: string]: unknown;
}

const RATE_RETRIES = 4;
const WRITE_IN_PROGRESS_RETRIES = 20;
const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KlerosDisputeService {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private nextId = 1;
  private nextSlot = 0;
  private paced: Promise<void> = Promise.resolve();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ServiceOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? DEFAULT_SLEEP;
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minIntervalMs ?? 2_100;
    this.readTimeoutMs = opts.readTimeoutMs ?? 60_000;
    this.writeTimeoutMs = opts.writeTimeoutMs ?? 240_000;
  }

  get url(): string {
    return this.opts.url;
  }

  /** Unauthenticated. Green means the HTTP process is up, not that the arbitration backend is. */
  async ping(): Promise<{ ok: boolean; status: number }> {
    const res = await this.fetchFn(new URL('/health', this.opts.url), { signal: AbortSignal.timeout(this.readTimeoutMs) });
    return { ok: res.ok, status: res.status };
  }

  /** The instructions string names the chain, court, juror count, alias slots and broadcast/simulate. */
  async initialize(): Promise<{ instructions?: string; serverInfo?: Json }> {
    const result = (await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-on-trial', version: '0.1.0' },
    })) as { instructions?: string; serverInfo?: Json };
    return { instructions: result.instructions, serverInfo: result.serverInfo };
  }

  async listTools(): Promise<ToolInfo[]> {
    const result = (await this.rpc('tools/list', {})) as { tools?: ToolInfo[] };
    return result.tools ?? [];
  }

  /** Any tool, raw. Throws ToolError on isError. Writes go through disputeCreate / evidencePin / evidenceSubmit. */
  async callTool(name: string, args: Json, timeoutMs = this.readTimeoutMs): Promise<{ text: string; json: Json | null }> {
    const result = (await this.rpc('tools/call', { name, arguments: args }, timeoutMs)) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
      structuredContent?: Json;
    };
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    if (result.isError) throw new ToolError(name, text);
    return { text, json: result.structuredContent ?? lastJsonObject(text) };
  }

  /** Step 1. `aliases` is always sent, `{}` included: an empty argument object is refused (ALIASES_REQUIRED). */
  async disputeCreate(aliases: Record<string, string>): Promise<WriteOutcome> {
    const { json, text } = await this.write('dispute_create', { aliases });
    return writeOutcome('dispute_create', json, text);
  }

  /** Step 2. Publication is permanent and public. Run it before step 1 so the evidence period is not spent uploading. */
  async evidencePin(bytes: Uint8Array, extension: string): Promise<PinOutcome> {
    const { json, text } = await this.write('evidence_pin', { attachment: Buffer.from(bytes).toString('base64'), extension });
    const status = json?.status;
    if (status !== 'checked' && status !== 'published') throw new Error(`evidence_pin returned no status: ${text.slice(0, 200)}`);
    const fileURI = typeof json?.fileURI === 'string' ? json.fileURI : undefined;
    if (status === 'published' && !fileURI) throw new Error('evidence_pin published without a fileURI');
    return { status, fileURI, cid: typeof json?.cid === 'string' ? json.cid : undefined, raw: json ?? {} };
  }

  /** Step 3. `dispute` is the Core id. Another real dispute's id is accepted, indexed and wrong. */
  async evidenceSubmit(input: { dispute: string; name: string; description: string; fileUri?: string; fileTypeExtension?: string }): Promise<WriteOutcome> {
    if (!/^\d+$/.test(input.dispute)) throw new Error(`evidence_submit needs a Core dispute id (digits), got ${input.dispute}`);
    const args: Json = { dispute: input.dispute, name: input.name, description: input.description };
    if (input.fileUri) {
      args.fileUri = input.fileUri;
      if (input.fileTypeExtension) args.fileTypeExtension = input.fileTypeExtension;
    }
    const { json, text } = await this.write('evidence_submit', args);
    return writeOutcome('evidence_submit', json, text);
  }

  /** Step 4. Always pass chain: without it the read fans out over ethereum, gnosis and arbitrum-one. */
  async disputeGet(id: string, chain: KlerosChain): Promise<DisputeRow> {
    const { json, text } = await this.callTool('dispute_get', { id, chain });
    const items = (json?.items ?? []) as DisputeRow[];
    const row = items.find((r) => String(r.id) === id && (!r.chain || r.chain === chain)) ?? items[0];
    if (!row) throw new Error(`dispute ${id} not found on ${chain}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return row;
  }

  /**
   * One write at a time from this process; WRITE_IN_PROGRESS (another writer on
   * the same key) is retried because nothing was sent. Anything that may have
   * left (a transport failure, a 5xx, a JSON-RPC error other than "no such
   * tool") is an in-doubt ToolError, never retried.
   */
  private write(tool: string, args: Json): Promise<{ text: string; json: Json | null }> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.callTool(tool, args, this.writeTimeoutMs);
        } catch (err) {
          if (err instanceof ToolError && err.code === 'WRITE_IN_PROGRESS' && attempt < WRITE_IN_PROGRESS_RETRIES) {
            await this.sleep(Math.min(15_000, 3_000 * (attempt + 1)));
            continue;
          }
          if (err instanceof ToolError) throw err;
          if (err instanceof RpcError && err.code === -32601) throw err; // the key has no such tool: nothing ran
          if (err instanceof ServiceHttpError && err.notSent) throw err;
          if (neverConnected(err)) throw new ToolError(tool, `the connection failed before the request was sent: ${(err as Error).message}`, 'not-sent');
          throw new ToolError(tool, `the request failed after it left and may have been sent: ${(err as Error).message}`, 'in-doubt');
        }
      }
    };
    const next = this.writing.then(run, run);
    this.writing = next.catch(() => undefined);
    return next;
  }

  private async rpc(method: string, params: Json, timeoutMs = this.readTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const res = await this.fetchFn(this.opts.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.status === 429 && attempt < RATE_RETRIES) {
        await this.sleep(5_000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new ServiceHttpError(res.status, text);
      const msg = parseRpcBody(text, id);
      if (msg.error) throw new RpcError(msg.error.code, msg.error.message);
      return msg.result;
    }
  }

  /** Keeps this process under the per-key limit. Calls queue, one slot every minIntervalMs. */
  private pace(): Promise<void> {
    const turn = this.paced.then(async () => {
      const wait = this.nextSlot - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextSlot = this.now() + this.minIntervalMs;
    });
    this.paced = turn.catch(() => undefined);
    return turn;
  }
}

/**
 * fetch failed before a byte reached the service: refused, unresolvable or
 * untrusted. A reset, a socket error or a timeout may come after the body
 * went out, so those stay in doubt.
 */
const NEVER_CONNECTED = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|CERT_|ERR_TLS_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT)/;

function neverConnected(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; cause?: { code?: string } } })?.cause;
  const code = cause?.code ?? cause?.cause?.code;
  return err instanceof TypeError && typeof code === 'string' && NEVER_CONNECTED.test(code);
}

function writeOutcome(tool: string, json: Json | null, text: string): WriteOutcome {
  const status = json?.status;
  if (status !== 'simulated' && status !== 'mined' && status !== 'unknown') {
    // A success we cannot read is not something to build on: whatever happened may have been sent.
    throw new ToolError(tool, `unreadable result, the transaction may have been sent: ${text.slice(0, 300)}`, 'in-doubt');
  }
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
  return {
    status,
    chain: str(json?.chain),
    txHash: str(json?.txHash ?? json?.transactionHash),
    coreDisputeID: str(json?.coreDisputeID),
    localDisputeID: str(json?.localDisputeID),
    localDisputeIDUnavailable: str(json?.localDisputeIDUnavailable),
    raw: json ?? {},
  };
}

/** "INSUFFICIENT_BALANCE: …" -> INSUFFICIENT_BALANCE. Prose, not a field: expect the wording to move. */
export function errorCode(text: string): string | undefined {
  return text.match(/^\s*(?:Error:\s*)?([A-Z][A-Z0-9_]{2,}):/)?.[1];
}

/**
 * A 200 is one SSE frame ("event: message\ndata: {...}"). Plain JSON is
 * accepted too. Returns the JSON-RPC message answering `id`.
 */
export function parseRpcBody(body: string, id?: number): { result?: unknown; error?: { code: number; message: string } } {
  const trimmed = body.trim();
  const messages: Json[] = [];
  if (trimmed.startsWith('{')) {
    messages.push(JSON.parse(trimmed) as Json);
  } else {
    for (const event of trimmed.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) messages.push(JSON.parse(data) as Json);
    }
  }
  const msg = messages.find((m) => id === undefined || m.id === id) ?? messages.find((m) => 'result' in m || 'error' in m);
  if (!msg) throw new Error(`no JSON-RPC message in the response: ${body.slice(0, 200)}`);
  return msg as { result?: unknown; error?: { code: number; message: string } };
}

/**
 * The last top-level JSON object in a text. Tool results can carry a warning
 * before the JSON (status unknown) and "Suggested commands" after it.
 */
export function lastJsonObject(text: string): Json | null {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth > 0 && inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (depth > 0 && c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) spans.push([start, i + 1]);
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(text.slice(spans[i][0], spans[i][1]));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
    } catch {
      /* not JSON, keep looking */
    }
  }
  return null;
}
