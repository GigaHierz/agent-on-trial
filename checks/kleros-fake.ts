import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * A stand-in for the Kleros Dispute Service, for rehearsing without a key.
 * Same wire as the real one: bearer auth, both media types in Accept, SSE
 * framed 200s, no batches, isError prose shaped "CODE: message", one write at
 * a time, `unknown` prefixed with a warning, "Suggested commands" after reads.
 * The dispute walks Evidence -> Commit -> Vote -> Appeal -> Executed on a
 * clock, tied until the vote, then `ruling`.
 *
 *   pnpm kleros:fake [--port 4410] [--period-ms 5000] [--ruling 1|2|tied] [--mode mined|simulated|unknown|timeout]
 *   (it prints the env and the check:dispute command to run against it)
 *
 * Tests drive it in process through handle(), with their own clock.
 */
export interface FakeOptions {
  apiKey?: string;
  chain?: 'arbitrum-sepolia-testnet' | 'arbitrum-one';
  court?: string;
  jurors?: number;
  slots?: string[];
  create?: 'mined' | 'simulated' | 'unknown' | 'timeout';
  /** A refusal text for dispute_create, e.g. 'FILING_FAILED: …' or 'TRANSACTION_REVERTED: … 0x…'. Overrides `create`. */
  createRefusal?: string;
  /** A refusal text for evidence_submit, e.g. 'SUBMISSION_FAILED: …'. */
  submitRefusal?: string;
  /** dispute_get answers with this refusal text, for the first N calls. */
  readFailures?: { text: string; times: number };
  /** The first N reads from Vote on come back degraded, without their answers (common on the Testnet). */
  degradedRuledReads?: number;
  /** Periods stop moving at this one, deadline and all, as on the Testnet where nobody passes the period. */
  stallAt?: 'Evidence' | 'Commit' | 'Vote' | 'Appeal';
  pin?: 'published' | 'checked';
  submit?: 'mined' | 'simulated' | 'unknown';
  /** The first-round majority, or a tie. */
  ruling?: number | 'tied';
  /** Evidence, Commit, Vote, Appeal, in ms. */
  periodsMs?: [number, number, number, number];
  rulingOptions?: { value: number; title: string }[];
  /** Instructions sent on initialize. Default names the chain, court, jurors, slots and mode. */
  instructions?: string;
  /** Core ids start here; the arbitrable's own id is core - localIdGap, as on the Testnet. */
  firstId?: number;
  localIdGap?: number;
  /** Make the first N writes come back WRITE_IN_PROGRESS. */
  busyWrites?: number;
  /** Make the first N requests come back 429. */
  rateLimited?: number;
  now?: () => number;
}

interface FakeDispute {
  core: number;
  local: number;
  createdAt: number;
  aliases: Record<string, string>;
  evidence: { name: string; description: string; fileUri?: string; fileTypeExtension?: string; at: number }[];
}

export interface FakeCall {
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
}

const ZERO = /^0x0{40}$/i;
/** The real service refuses "a zero address or a placeholder"; precompile-range addresses stand in for that here. */
const PLACEHOLDER = /^0x0{36}[0-9a-f]{4}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function createFakeKleros(opts: FakeOptions = {}) {
  const o = {
    apiKey: 'fake',
    chain: 'arbitrum-sepolia-testnet' as const,
    court: '8',
    jurors: 1,
    slots: ['buyer', 'provider'],
    create: 'mined' as const,
    pin: 'published' as const,
    submit: 'mined' as const,
    ruling: 1 as number | 'tied',
    periodsMs: [15 * 60_000, 45 * 60_000, 30 * 60_000, 45 * 60_000] as [number, number, number, number],
    rulingOptions: [
      { value: 0, title: 'Refuse to Arbitrate / Invalid' },
      { value: 1, title: 'Accept the claim' },
      { value: 2, title: 'Reject the claim' },
    ] as { value: number; title: string }[],
    firstId: 300,
    localIdGap: 50,
    busyWrites: 0,
    rateLimited: 0,
    now: Date.now,
    ...opts,
  };
  // The real service's shape: a general section that names every deployment, then the filing line for this key's Preset.
  const instructions =
    opts.instructions ??
    `Kleros Dispute Service (fake). Pass one of these as the \`chain\` argument:\n` +
      `  arbitrum-one              Kleros v2 Beta. The LIVE production deployment.\n` +
      `  arbitrum-sepolia-testnet  Kleros v2 Testnet. Test data only.\n\n` +
      `CREATING A DISPUTE. dispute_create files against your organisation's dispute template (x402 purchase dispute).\n` +
      `The court, juror count and template are fixed for you, and this call sends them:\n` +
      `court ${o.court}, ${o.jurors} jurors, on ${o.chain}.\n` +
      `${o.create === 'simulated' ? 'This call only simulates: nothing is sent.' : "This spends real arbitration fees from your organisation's wallet."}\n` +
      `Name parties with the REQUIRED \`aliases\` argument, keyed by slot: ${o.slots.join(', ')}.\n`;

  const disputes = new Map<number, FakeDispute>();
  const calls: FakeCall[] = [];
  let nextId = o.firstId;
  let busy = o.busyWrites;
  let limited = o.rateLimited;
  let readFailures = o.readFailures?.times ?? 0;
  let degradedRuledReads = o.degradedRuledReads ?? 0;

  const period = (d: FakeDispute) => {
    const t = o.now() - d.createdAt;
    const [e, c, v, a] = o.periodsMs;
    const order = ['Evidence', 'Commit', 'Vote', 'Appeal', 'Executed'];
    const by = t < e ? 'Evidence' : t < e + c ? 'Commit' : t < e + c + v ? 'Vote' : t < e + c + v + a ? 'Appeal' : 'Executed';
    return o.stallAt && order.indexOf(by) > order.indexOf(o.stallAt) ? o.stallAt : by;
  };

  const row = (d: FakeDispute) => {
    const status = period(d);
    const voted = status === 'Appeal' || status === 'Executed' || (status === 'Vote' && o.now() - d.createdAt > o.periodsMs[0] + o.periodsMs[1] + o.periodsMs[2] / 2);
    const tied = !voted || o.ruling === 'tied';
    const value = tied ? 0 : (o.ruling as number);
    const [e, c, v, a] = o.periodsMs;
    const ends = { Evidence: e, Commit: e + c, Vote: e + c + v, Appeal: e + c + v + a } as Record<string, number>;
    const starts = { Evidence: 0, Commit: e, Vote: e + c, Appeal: e + c + v, Executed: e + c + v + a } as Record<string, number>;
    return {
      id: String(d.core),
      disputeId: String(d.core),
      court: o.court,
      status,
      ruling: String(value),
      ruled: status === 'Executed',
      tied,
      roundCount: 1,
      deadline: ends[status] === undefined ? null : new Date(d.createdAt + ends[status]).toISOString(),
      lastPeriodChange: new Date(d.createdAt + starts[status]).toISOString(),
      createdAt: new Date(d.createdAt).toISOString(),
      chain: o.chain,
      ruledSemantics: 'onchain',
      round: { id: `${d.core}-0`, jurorCount: o.jurors },
      overridden: false,
      evidenceCount: null,
      rulingOptions: o.rulingOptions,
      rulingLabel: o.rulingOptions.find((r) => r.value === value)?.title ?? null,
      unresolvedFields: [] as string[],
      unresolvedReason: 'none',
    };
  };

  const tx = (seed: string) => '0x' + createHash('sha256').update(seed).digest('hex');
  const refuse = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
  const ok = (value: unknown, suffix = '') => ({ content: [{ type: 'text', text: JSON.stringify(value) + suffix }] });
  const WRITES = new Set(['dispute_create', 'evidence_pin', 'evidence_submit']);

  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
    dispute_create(args) {
      if (!('aliases' in args)) return refuse('ALIASES_REQUIRED: dispute_create needs an aliases object; send {} to name no party.');
      const aliases = args.aliases;
      if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return refuse('INVALID_ALIASES: aliases must be an object of slot to address.');
      for (const [slot, address] of Object.entries(aliases as Record<string, unknown>)) {
        if (!o.slots.includes(slot)) return refuse(`UNKNOWN_ALIAS_SLOT: "${slot}" is not a slot of this Preset (${o.slots.join(', ')}).`);
        if (typeof address !== 'string' || !ADDRESS.test(address)) return refuse(`INVALID_ALIASES: slot "${slot}" is not an address.`);
        if (ZERO.test(address) || PLACEHOLDER.test(address)) return refuse(`ZERO_ADDRESS_ALIAS: slot "${slot}" is the zero address or a placeholder; omit the slot instead.`);
      }
      if (o.createRefusal) return refuse(o.createRefusal);
      if (o.create === 'simulated') return ok({ status: 'simulated', chain: o.chain, court: o.court, jurors: o.jurors, fee: '810000000000000' });
      if (o.create === 'timeout') return refuse('FILING_TIMED_OUT: the filing did not finish in three minutes and was stopped; the transaction may have been sent.');
      const core = nextId++;
      const d: FakeDispute = { core, local: core - o.localIdGap, createdAt: o.now(), aliases: aliases as Record<string, string>, evidence: [] };
      disputes.set(core, d);
      const txHash = tx(`create-${core}`);
      if (o.create === 'unknown') {
        return { content: [{ type: 'text', text: `WARNING: the transaction was broadcast but no receipt arrived in time. The dispute probably exists. Do not file again.\n${JSON.stringify({ status: 'unknown', txHash })}` }] };
      }
      return ok({ status: 'mined', txHash, coreDisputeID: String(core), localDisputeID: String(d.local), chain: o.chain });
    },

    evidence_pin(args) {
      const attachment = args.attachment;
      const extension = args.extension;
      if (typeof attachment !== 'string' || attachment.startsWith('data:') || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment) || attachment.length % 4 !== 0) {
        return refuse('ATTACHMENT_INVALID: attachment must be padded base64 (RFC 4648 §4), not base64url and not a data: URI.');
      }
      if (typeof extension !== 'string' || !/^[a-z0-9]{1,10}$/.test(extension)) return refuse('EXTENSION_INVALID: one to ten lowercase letters or digits, no dot.');
      const bytes = Buffer.from(attachment, 'base64');
      if (bytes.length === 0) return refuse('ATTACHMENT_EMPTY: the file is empty.');
      if (o.pin === 'checked') return ok({ status: 'checked', bytes: bytes.length, extension });
      const cid = 'bafkrei' + createHash('sha256').update(bytes).digest('hex').slice(0, 52);
      return ok({ status: 'published', fileURI: `/ipfs/${cid}`, cid, verified: true });
    },

    evidence_submit(args) {
      const id = String(args.dispute ?? '');
      if (!/^\d+$/.test(id)) return refuse('DISPUTE_INVALID: dispute must be the Core dispute id, digits only.');
      const d = disputes.get(Number(id));
      if (!d) return refuse(`DISPUTE_NOT_FOUND: the arbitrator cannot resolve dispute ${id}.`);
      if (typeof args.name !== 'string' || !args.name || args.name.length > 1024) return refuse('NAME_INVALID: name is required, at most 1 KiB.');
      if (typeof args.description !== 'string' || !args.description || Buffer.byteLength(args.description) > 65_536) return refuse('DESCRIPTION_INVALID: description is required, at most 64 KiB.');
      if (args.fileTypeExtension !== undefined && args.fileUri === undefined) return refuse('FILE_URI_INVALID: fileTypeExtension describes a fileUri and means nothing alone.');
      if (args.fileUri !== undefined && (typeof args.fileUri !== 'string' || /\s/.test(args.fileUri) || args.fileUri.startsWith('-') || args.fileUri.length > 1024)) {
        return refuse('FILE_URI_INVALID: at most 1024 characters, no whitespace, no leading "-".');
      }
      if (o.submitRefusal) return refuse(o.submitRefusal);
      if (o.submit === 'simulated') return ok({ status: 'simulated', dispute: id });
      d.evidence.push({ name: args.name, description: args.description, fileUri: args.fileUri as string | undefined, fileTypeExtension: args.fileTypeExtension as string | undefined, at: o.now() });
      const txHash = tx(`evidence-${id}-${d.evidence.length}`);
      if (o.submit === 'unknown') return { content: [{ type: 'text', text: `WARNING: broadcast, no receipt yet. Do not submit again.\n${JSON.stringify({ status: 'unknown', txHash })}` }] };
      return ok({ status: 'mined', txHash, dispute: id });
    },

    dispute_get(args) {
      if (readFailures > 0) {
        readFailures--;
        return refuse(o.readFailures!.text);
      }
      const id = String(args.id ?? '');
      const chain = args.chain as string | undefined;
      const d = disputes.get(Number(id));
      let items = d && (!chain || chain === o.chain) ? [row(d)] : [];
      if (items[0] && degradedRuledReads > 0 && ['Vote', 'Appeal', 'Executed'].includes(items[0].status)) {
        degradedRuledReads--;
        items = [{ ...items[0], rulingOptions: [], rulingLabel: null, unresolvedFields: ['rulingOptions'], unresolvedReason: 'template unreadable' }];
      }
      return ok(
        { items, nextCursor: null, hasMore: false, chainStatus: [{ chain: chain ?? o.chain, ok: true }] },
        `\n\nSuggested commands:\n  kleros evidence list --dispute ${d?.local ?? id} --chain ${o.chain} - Review full evidence record`,
      );
    },

    evidence_list(args) {
      const local = Number(args.dispute);
      const d = [...disputes.values()].find((x) => x.local === local);
      return ok({ items: d?.evidence ?? [] });
    },
  };

  const schemas = [
    {
      name: 'dispute_create',
      description: 'Create a Kleros v2 dispute from this key\'s Preset.',
      inputSchema: {
        type: 'object',
        properties: { aliases: { type: 'object', description: `Party addresses by slot. Available slots: ${o.slots.join(', ')}. Omit any you do not know rather than passing a placeholder, and pass \`{}\` when you know none.`, additionalProperties: { type: 'string' } } },
        required: ['aliases'],
      },
    },
    { name: 'evidence_pin', inputSchema: { type: 'object', properties: { attachment: { type: 'string' }, extension: { type: 'string' } }, required: ['attachment', 'extension'] } },
    {
      name: 'evidence_submit',
      inputSchema: {
        type: 'object',
        properties: { dispute: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, fileUri: { type: 'string' }, fileTypeExtension: { type: 'string' } },
        required: ['dispute', 'name', 'description'],
      },
    },
    { name: 'dispute_get', inputSchema: { type: 'object', properties: { id: { type: 'string' }, chain: { type: 'string' } }, required: ['id'] } },
    { name: 'evidence_list', inputSchema: { type: 'object', properties: { dispute: { type: 'string' }, chain: { type: 'string' } }, required: ['dispute'] } },
  ];

  const plain = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const sse = (body: unknown) => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return plain(200, { status: 'ok' });
    if (url.pathname !== '/mcp' || req.method !== 'POST') return plain(404, { error: 'not found' });
    if (req.headers.get('authorization') !== `Bearer ${o.apiKey}`) return plain(401, { error: 'unauthorized' });
    if (limited > 0) {
      limited--;
      return plain(429, { error: 'rate limit exceeded' });
    }
    const accept = req.headers.get('accept') ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return plain(406, { jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' }, id: null });
    }
    const msg = (await req.json()) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | unknown[];
    if (Array.isArray(msg)) return plain(400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: JSON-RPC batches are not accepted. Send one request per POST.' }, id: null });
    const reply = (result: unknown) => sse({ result, jsonrpc: '2.0', id: msg.id });
    calls.push({ method: msg.method ?? '', tool: msg.params?.name, args: msg.params?.arguments });

    if (msg.method === 'initialize') {
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kleros-dispute-service-fake', version: '0.0.0' }, instructions });
    }
    if (msg.method === 'tools/list') return reply({ tools: schemas });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name ?? '';
      const tool = tools[name];
      if (!tool) return sse({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${name}` }, id: msg.id });
      if (WRITES.has(name) && busy > 0) {
        busy--;
        return reply(refuse('WRITE_IN_PROGRESS: another write on this key is still running. Nothing was sent; call again once it has returned.'));
      }
      return reply(tool(msg.params?.arguments ?? {}));
    }
    return sse({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${msg.method}` }, id: msg.id });
  }

  /** A fetch that answers from this fake, for tests. */
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch;

  return { handle, fetch: fetchFn, calls, disputes, instructions, options: o };
}

async function serve() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const port = Number(arg('--port') ?? 4410);
  const p = Number(arg('--period-ms') ?? 5_000);
  const rulingArg = arg('--ruling') ?? '1';
  const fake = createFakeKleros({
    apiKey: process.env.KLEROS_FAKE_KEY ?? 'fake',
    // A fresh range per start, so a restarted fake does not reuse ids already in the state file.
    firstId: 1_000 + Math.floor(Math.random() * 900_000),
    periodsMs: [p, p, p, p],
    ruling: rulingArg === 'tied' ? 'tied' : Number(rulingArg),
    create: (arg('--mode') as FakeOptions['create']) ?? 'mined',
  });
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const response = await fake.handle(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body }));
    const last = fake.calls.at(-1);
    if (last && req.method === 'POST') console.log(`${new Date().toISOString().slice(11, 19)} ${last.method}${last.tool ? ` ${last.tool}` : ''} -> ${response.status}`);
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
    res.end(await response.text());
  }).listen(port, () => {
    console.log(`fake Kleros Dispute Service on http://localhost:${port}/mcp · key "${fake.options.apiKey}" · periods ${p} ms · ruling ${rulingArg} · create ${fake.options.create}`);
    console.log(fake.instructions);
    console.log(`\nKLEROS_SERVICE_URL=http://localhost:${port}/mcp KLEROS_API_KEY_TESTNET=${fake.options.apiKey} KLEROS_RULING_MAP="1=complainant:Accept the claim,2=respondent:Reject the claim" KLEROS_POLL_MS=1000 DISPUTE=kleros pnpm check:dispute --file --wait ${p * 5}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void serve();
