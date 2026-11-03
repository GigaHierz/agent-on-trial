import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAIP2, DEMO_TOKEN } from '@trial/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { KlerosDispute, STALE_PREPARING_MS, jurorAttachment, jurorDocument, klerosConfig, parseRulingMap, periodStatus, presetChain, presetFingerprint, presetFiling, presetMode, presetSlots, type Filing, type KlerosDeps } from '../adapters/dispute/kleros.js';
import { KlerosDisputeService, ServiceHttpError, ToolError, classify, errorCode, lastJsonObject, parseRpcBody } from '../adapters/dispute/kleros-service.js';
import type { DisputeEvidence } from '../adapters/dispute/types.js';
import { LocalStorage } from '../adapters/storage/local.js';
import { createFakeKleros, type FakeOptions } from '../checks/kleros-fake.js';

const dir = mkdtempSync(join(tmpdir(), 'trial-kleros-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const silent: KlerosDeps['log'] = { info: () => {}, warn: () => {} };
const MIN = 60_000;
const MAP = '1=complainant:Accept the claim,2=respondent:Reject the claim';
let n = 0;

function setup(fakeOpts: FakeOptions = {}, env: Record<string, string> = {}, shared?: { stateFile: string; clock: { t: number } }) {
  const clock = shared?.clock ?? { t: Date.parse('2026-11-02T10:00:00Z') };
  const now = () => clock.t;
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  const fake = createFakeKleros({ now, ...fakeOpts });
  const storage = new LocalStorage(join(dir, 'store'));
  const stateFile = shared?.stateFile ?? join(dir, `state-${++n}.json`);
  const make = (more: Record<string, string> = {}, f = fake) =>
    new KlerosDispute(
      storage,
      {
        KLEROS_API_KEY: 'fake',
        KLEROS_SERVICE_URL: 'http://fake.kleros/mcp',
        KLEROS_STATE_FILE: stateFile,
        KLEROS_RULING_MAP: MAP,
        ...env,
        ...more,
      },
      { fetch: f.fetch, now, sleep, log: silent },
    );
  const kleros = make();
  const tools = () => fake.calls.filter((c) => c.method === 'tools/call').map((c) => c.tool);
  return { fake, kleros, storage, tools, make, stateFile, clock, advance: (ms: number) => void (clock.t += ms) };
}

async function evidence(storage: LocalStorage, opts: { tx?: string; respondent?: `0x${string}`; body?: string } = {}): Promise<DisputeEvidence> {
  const delivered = await storage.put(opts.body ?? '{"report":"Celo market outlook: strong fundamentals."}');
  return {
    complainant: { address: '0x1111111111111111111111111111111111111111', agentId: '1' },
    respondent: { address: opts.respondent ?? '0x2222222222222222222222222222222222222222', agentId: '2', endpoint: 'http://localhost:4402/report/celo' },
    receipt: { txHash: `0x${(opts.tx ?? '11').repeat(32)}` as `0x${string}`, amount: '0.01', asset: DEMO_TOKEN.address, network: CAIP2, receiptRef: delivered },
    expected: 'a Celo market report with sections: price, volume, sources',
    delivered,
    claim: 'I paid 0.01 USD₮ for a report with price, volume and sources. The body has none of them.',
  };
}

describe('Kleros Dispute Service wire', () => {
  it('reads an SSE frame and plain JSON', () => {
    expect(parseRpcBody('event: message\ndata: {"result":{"a":1},"jsonrpc":"2.0","id":7}\n\n', 7).result).toEqual({ a: 1 });
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}', 1).error?.code).toBe(-32601);
  });

  it('finds the JSON after a warning and before suggested commands', () => {
    expect(lastJsonObject('WARNING: no receipt {yet}.\n{"status":"unknown","txHash":"0xab"}')).toEqual({ status: 'unknown', txHash: '0xab' });
    expect(lastJsonObject('{"items":[{"t":"a } brace"}]}\n\nSuggested commands:\n  kleros evidence list --dispute 81')).toEqual({ items: [{ t: 'a } brace' }] });
    expect(lastJsonObject('no json here')).toBeNull();
  });

  it('treats only the documented refusals as "nothing sent"', () => {
    expect(errorCode('INSUFFICIENT_BALANCE: the wallet cannot cover the fee')).toBe('INSUFFICIENT_BALANCE');
    expect(errorCode('something else')).toBeUndefined();
    expect(classify('dispute_create', 'INSUFFICIENT_BALANCE')).toBe('not-sent');
    expect(classify('dispute_create', 'WRITE_IN_PROGRESS')).toBe('not-sent');
    for (const code of ['FILING_FAILED', 'FILING_CHILD_FAILED', 'FILING_TIMED_OUT', 'NONCE_TOO_LOW', undefined]) expect(classify('dispute_create', code)).toBe('in-doubt');
    expect(classify('dispute_create', 'TRANSACTION_REVERTED')).toBe('reverted');
    expect(classify('evidence_submit', 'DISPUTE_NOT_FOUND')).toBe('not-sent');
    for (const code of ['SUBMISSION_FAILED', 'BROADCAST_FAILED', 'RPC_ERROR']) expect(classify('evidence_submit', code)).toBe('in-doubt');
    expect(classify('dispute_get', 'RPC_ERROR')).toBe('not-sent');
    expect(new ToolError('dispute_create', 'Output validation error: bad shape').maybeSent).toBe(true);
    expect(new ToolError('dispute_create', `TRANSACTION_REVERTED: mined and failed (tx 0x${'ab'.repeat(32)})`).txHash).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('sends both media types and the bearer key, backs off on 429 and retries WRITE_IN_PROGRESS', async () => {
    let t = 0;
    const fake = createFakeKleros({ rateLimited: 2, busyWrites: 2, now: () => t });
    const svc = new KlerosDisputeService({ url: 'http://fake.kleros/mcp', apiKey: 'fake', fetch: fake.fetch, now: () => t, sleep: async (ms) => void (t += ms) });
    const out = await svc.disputeCreate({});
    expect(out.status).toBe('mined');
    expect(out.coreDisputeID).toBe('300');
    expect(out.localDisputeID).toBe('250');
    expect(out.chain).toBe('arbitrum-sepolia-testnet');
    expect(fake.calls.filter((c) => c.tool === 'dispute_create')).toHaveLength(3);
  });

  it('reports 401 as not sent, and a refused Accept header never reaches a tool', async () => {
    const fake = createFakeKleros();
    const svc = new KlerosDisputeService({ url: 'http://fake.kleros/mcp', apiKey: 'wrong', fetch: fake.fetch, minIntervalMs: 0 });
    const err = await svc.disputeCreate({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceHttpError);
    expect((err as ServiceHttpError).status).toBe(401);
    expect((err as ServiceHttpError).notSent).toBe(true);
    const res = await fake.handle(new Request('http://fake.kleros/mcp', { method: 'POST', headers: { authorization: 'Bearer fake', accept: 'application/json' }, body: '{}' }));
    expect(res.status).toBe(406);
  });

  it('reads a JSON-RPC error on a write as in doubt, unless the tool is absent', async () => {
    const rpcError = (code: number) =>
      (async () => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message: 'boom' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const svc = (code: number) => new KlerosDisputeService({ url: 'http://x/mcp', apiKey: 'k', fetch: rpcError(code), minIntervalMs: 0 });
    expect(((await svc(-32603).disputeCreate({}).catch((e: unknown) => e)) as ToolError).maybeSent).toBe(true);
    expect(await svc(-32601).disputeCreate({}).catch((e: unknown) => (e as Error).name)).toBe('RpcError');
  });
});

describe('kleros config', () => {
  it('defaults to the Testnet and refuses the retired slug', () => {
    expect(klerosConfig({}).chain).toBe('arbitrum-sepolia-testnet');
    expect(klerosConfig({}).courtUrl).toBe('https://v2-testnet.kleros.builders');
    expect(klerosConfig({}).rulingMap).toBeUndefined();
    expect(() => klerosConfig({ KLEROS_CHAIN: 'arbitrum-sepolia' })).toThrow(/retired/);
    expect(() => klerosConfig({ KLEROS_CHAIN: 'gnosis' })).toThrow(/not one of/);
  });

  it('picks the key of the chain, with KLEROS_API_KEY as the fallback', () => {
    const both = { KLEROS_API_KEY_TESTNET: 'test-key', KLEROS_API_KEY_BETA: 'beta-key' };
    expect(klerosConfig(both)).toMatchObject({ apiKey: 'test-key', keyVar: 'KLEROS_API_KEY_TESTNET' });
    expect(klerosConfig({ ...both, KLEROS_CHAIN: 'arbitrum-one' })).toMatchObject({ apiKey: 'beta-key', keyVar: 'KLEROS_API_KEY_BETA' });
    expect(klerosConfig({ KLEROS_API_KEY_BETA: 'beta-key' })).toMatchObject({ apiKey: undefined, keyVar: 'KLEROS_API_KEY_TESTNET' });
    expect(klerosConfig({ KLEROS_API_KEY: 'one-key', KLEROS_CHAIN: 'arbitrum-one' })).toMatchObject({ apiKey: 'one-key', keyVar: 'KLEROS_API_KEY' });
  });

  it('reads the ruling map by answer value, with optional title pins', () => {
    expect([...parseRulingMap('2=complainant:Award Sender, 3=respondent, 1=refused')]).toEqual([
      [2, { winner: 'complainant', title: 'Award Sender' }],
      [3, { winner: 'respondent', title: undefined }],
      [1, { winner: 'refused', title: undefined }],
    ]);
    expect(() => parseRulingMap('0=complainant')).toThrow(/refuse/);
    expect(() => parseRulingMap('1=buyer')).toThrow(/cannot read/);
  });

  it('reads the chain only when the instructions name exactly one', () => {
    expect(presetChain('files on arbitrum-sepolia-testnet, court 8')).toBe('arbitrum-sepolia-testnet');
    expect(presetChain('files on arbitrum-one, court 34')).toBe('arbitrum-one');
    expect(presetChain('rehearse on arbitrum-sepolia-testnet before arbitrum-one')).toBeUndefined();
    expect(presetChain(undefined)).toBeUndefined();
    expect(presetChain('This Preset files on Arbitrum One (Kleros v2 Beta), court 34.')).toBe('arbitrum-one');
    expect(presetChain('Files on Arbitrum One, court 34. Rehearse with your Testnet key (arbitrum-sepolia-testnet) first.')).toBeUndefined();
    expect(presetChain('Files on Arbitrum Sepolia, court 8.')).toBe('arbitrum-sepolia-testnet');
  });

  // The shape of the real service's instructions (Testnet key, 2026-11-03): every deployment is named, then the filing line.
  const REAL = [
    'Pass one of these as the `chain` argument:',
    '  arbitrum-one              Kleros v2 Beta. The LIVE production deployment - real disputes, real',
    '                            arbitration fees, real money. "Beta" is the release, not a test network.',
    '  arbitrum-sepolia-testnet  Kleros v2 Testnet. Test data only.',
    '`arbitrum-sepolia` is RETIRED and is now refused. It named the Devnet - `arbitrum-sepolia-devnet`.',
    'CREATING A DISPUTE. dispute_create files against your organisation\'s dispute template.',
    'The court, juror count and template are fixed for you, and this call sends them:',
    'court 8, 1 jurors, on arbitrum-sepolia-testnet.',
    "This spends real arbitration fees from your organisation's wallet.",
    'Name parties with the REQUIRED `aliases` argument, keyed by slot: buyer, provider.',
  ].join('\n');

  it('reads the filing line of the real instructions over the deployments they list', () => {
    expect(presetFiling(REAL)).toEqual({ court: '8', jurors: 1, chain: 'arbitrum-sepolia-testnet' });
    expect(presetChain(REAL)).toBe('arbitrum-sepolia-testnet');
    expect(presetChain(REAL.replace('court 8, 1 jurors, on arbitrum-sepolia-testnet', 'court 34, 5 jurors, on arbitrum-one'))).toBe('arbitrum-one');
    expect(presetChain(REAL.replace('on arbitrum-sepolia-testnet.', 'on arbitrum-sepolia-devnet.'))).toBe('arbitrum-sepolia-devnet');
    expect(presetChain(`${REAL}\ncourt 34, 5 jurors, on arbitrum-one.`)).toBeUndefined();
    expect(presetMode(REAL)).toBe('broadcast');
    expect(presetSlots({ description: 'Party addresses by slot. Available slots: buyer, provider. Omit any you do not know.' }, undefined)).toEqual(['buyer', 'provider']);
    expect(presetSlots({}, REAL)).toEqual(['buyer', 'provider']);
    expect(presetSlots({ properties: { seller: {} } }, REAL)).toEqual(['seller']);
    expect(presetSlots(undefined, 'no slots here')).toEqual([]);
  });

  it('maps Appeal to a ruling unless execution is what we wait for', () => {
    expect(periodStatus('Appeal')).toBe('ruled');
    expect(periodStatus('Appeal', 'executed')).toBe('open');
    expect(periodStatus('Executed', 'executed')).toBe('ruled');
    expect(periodStatus('Evidence')).toBe('evidence');
  });
});

describe('kleros dispute adapter', () => {
  it('pins, files, submits against the Core id, then reads the ruling once the vote is over', async () => {
    const { fake, kleros, storage, tools } = setup();
    const opened = await kleros.open(await evidence(storage));
    expect(tools()).toEqual(['evidence_pin', 'dispute_create', 'evidence_submit']);
    expect(opened.disputeId).toBe('300');
    expect(opened.url).toBe('https://v2-testnet.kleros.builders/#/cases/300/overview');
    expect(opened.detail).toMatchObject({ kleros: 'arbitrum-sepolia-testnet', coreDisputeID: '300', localDisputeID: '250', evidenceSubmitted: 'mined' });

    const d = fake.disputes.get(300)!;
    expect(d.aliases).toEqual({ buyer: '0x1111111111111111111111111111111111111111', provider: '0x2222222222222222222222222222222222222222' });
    expect(d.evidence).toHaveLength(1);
    expect(d.evidence[0].fileUri).toMatch(/^\/ipfs\/bafkrei/);
    expect(d.evidence[0].fileTypeExtension).toBe('json');
    expect(d.evidence[0].description).toContain('The body has none of them.');
    expect(d.evidence[0].description).toContain('strong fundamentals');

    expect(await kleros.status('300')).toBe('evidence');
    expect(await kleros.ruling('300')).toBeNull();
    const ruling = await kleros.ruling('300', { waitMs: 3 * 60 * MIN });
    expect(ruling?.winner).toBe('complainant');
    expect(ruling?.externalId).toBe('300');
    expect(ruling?.proofUrl).toBe(opened.url);
    expect(ruling?.rationale).toMatch(/ruled 1 "Accept the claim" \(the vote is over\)/);
    const doc = JSON.parse(new TextDecoder().decode(await storage.get(ruling!.ref!.uri)));
    expect(doc.kleros).toMatchObject({ coreDisputeID: '300', localDisputeID: '250', period: 'Vote', ruling: 1, tied: false, final: true });
    expect(await kleros.status('300')).toBe('ruled');
  });

  it('never pays twice for one receipt, called again or called twice at once', async () => {
    const { kleros, storage, tools } = setup();
    const ev = await evidence(storage);
    const [a, b] = await Promise.all([kleros.open(ev), kleros.open(ev)]);
    expect(b.disputeId).toBe(a.disputeId);
    expect((await kleros.open(ev)).disputeId).toBe(a.disputeId);
    expect(tools().filter((t) => t === 'dispute_create')).toHaveLength(1);
    expect((await kleros.open(await evidence(storage, { tx: '22' }))).disputeId).toBe('301');
  });

  it('refuses a receipt another process is filing', async () => {
    const first = setup({ create: 'simulated' });
    const ev = await evidence(first.storage);
    const other = first.make();
    const [a, b] = await Promise.allSettled([first.kleros.open(ev), other.open(ev)]);
    const refused = [a, b].filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/another process .* is preparing/);
  });

  it('stops for a human whenever a filing may have been sent, and keeps stopping', async () => {
    const texts = [
      'FILING_FAILED: the Disputant CLI exited 1',
      'FILING_CHILD_FAILED: the filing process died; the transaction may have gone out',
      'NONCE_TOO_LOW: a code nobody documented',
      'the arbitration backend crashed',
    ];
    for (const fakeOpts of [{ create: 'unknown' }, { create: 'timeout' }, ...texts.map((createRefusal) => ({ createRefusal }))] as FakeOptions[]) {
      const { kleros, storage, tools } = setup(fakeOpts);
      const ev = await evidence(storage);
      await expect(kleros.open(ev)).rejects.toThrow(/may already exist.*Not filing again/);
      await expect(kleros.open(ev)).rejects.toThrow(/may already exist/);
      expect(tools().filter((t) => t === 'dispute_create')).toHaveLength(1);
      expect(kleros.store.all()[0].status).toBe('unknown');
    }
  });

  it('keeps a reverted filing and its transaction for a human', async () => {
    const tx = `0x${'cd'.repeat(32)}`;
    const { kleros, storage, tools } = setup({ createRefusal: `TRANSACTION_REVERTED: mined and failed, no dispute exists, the fee came back (tx ${tx})` });
    const ev = await evidence(storage);
    await expect(kleros.open(ev)).rejects.toThrow(/mined and reverted.*sepolia\.arbiscan\.io\/tx\/0xcdcd/);
    await expect(kleros.open(ev)).rejects.toThrow(/reverted/);
    expect(tools().filter((t) => t === 'dispute_create')).toHaveLength(1);
    expect(kleros.store.all()[0]).toMatchObject({ status: 'reverted', createTx: tx });
  });

  it('frees the receipt after a refusal that sent nothing, and pins the same attachment again', async () => {
    const { fake, kleros, storage, tools } = setup({ createRefusal: 'INSUFFICIENT_BALANCE: the fee wallet cannot cover the fee. Nothing was sent.' });
    const ev = await evidence(storage);
    await expect(kleros.open(ev)).rejects.toThrow(/INSUFFICIENT_BALANCE/);
    expect(kleros.store.all()).toHaveLength(0);
    fake.options.createRefusal = undefined;
    expect((await kleros.open(ev)).disputeId).toBe('300');
    expect(tools().filter((t) => t === 'dispute_create')).toHaveLength(2);
    const pins = fake.calls.filter((c) => c.tool === 'evidence_pin').map((c) => c.args?.attachment);
    expect(pins).toHaveLength(2);
    expect(pins[0]).toBe(pins[1]);
  });

  it('checks the alias slots before anything is sent', async () => {
    const { kleros, storage, tools } = setup({}, { KLEROS_ALIAS_RESPONDENT: 'Seller' });
    await expect(kleros.open(await evidence(storage))).rejects.toThrow(/"Seller" is not one of this Preset's alias slots/);
    expect(tools()).toEqual([]);
    expect(kleros.store.all()).toHaveLength(0);
  });

  it('reports a simulation as a simulation, and lets it be simulated again', async () => {
    const { kleros, storage, tools } = setup({ create: 'simulated', pin: 'checked' });
    const ev = await evidence(storage);
    const opened = await kleros.open(ev);
    expect(opened.disputeId).toMatch(/^simulated-/);
    expect(opened.url).toBeUndefined();
    expect(opened.detail).toMatchObject({ simulated: true, evidenceSubmitted: 'skipped' });
    expect(tools()).not.toContain('evidence_submit');
    expect(await kleros.status(opened.disputeId)).toBe('closed');
    expect(await kleros.ruling(opened.disputeId, { waitMs: 60 * MIN })).toBeNull();
    await kleros.open(ev);
    expect(tools().filter((t) => t === 'dispute_create')).toHaveLength(2);
  });

  it('leaves out a party it does not know instead of sending a zero address', async () => {
    const { fake, kleros, storage } = setup();
    await kleros.open(await evidence(storage, { respondent: '0x0000000000000000000000000000000000000000' }));
    expect(fake.disputes.get(300)!.aliases).toEqual({ buyer: '0x1111111111111111111111111111111111111111' });
  });

  it('leaves out a precompile-range placeholder too, and the fake refuses one like the service', async () => {
    const { fake, kleros, storage } = setup();
    await kleros.open(await evidence(storage, { respondent: '0x0000000000000000000000000000000000000002' }));
    expect(fake.disputes.get(300)!.aliases).toEqual({ buyer: '0x1111111111111111111111111111111111111111' });
    const direct = await fake.fetch('http://fake.kleros/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dispute_create', arguments: { aliases: { provider: '0x0000000000000000000000000000000000000001' } } } }),
    });
    expect(await direct.text()).toMatch(/ZERO_ADDRESS_ALIAS/);
  });

  it('always sends aliases, {} when no slot is configured or in the schema', async () => {
    const { fake, kleros, storage } = setup({ slots: [] });
    await kleros.open(await evidence(storage));
    expect(fake.calls.find((c) => c.tool === 'dispute_create')?.args).toEqual({ aliases: {} });
  });

  it('refuses to file when the key and KLEROS_CHAIN disagree, or on Beta without consent', async () => {
    const beta = setup({ chain: 'arbitrum-one', court: '34' });
    await expect(beta.kleros.open(await evidence(beta.storage))).rejects.toThrow(/files on arbitrum-one but KLEROS_CHAIN=arbitrum-sepolia-testnet/);
    expect(beta.tools()).toEqual([]);
    expect((await beta.kleros.health()).ok).toBe(false);

    const noConsent = setup({ chain: 'arbitrum-one' }, { KLEROS_CHAIN: 'arbitrum-one' });
    await expect(noConsent.kleros.open(await evidence(noConsent.storage))).rejects.toThrow(/KLEROS_ALLOW_BETA/);

    const consent = setup({ chain: 'arbitrum-one' }, { KLEROS_CHAIN: 'arbitrum-one', KLEROS_ALLOW_BETA: '1' });
    expect((await consent.kleros.open(await evidence(consent.storage))).url).toBe('https://v2.kleros.builders/#/cases/300/overview');
  });

  it('wants the instructions to name the chain, or the fingerprint of the ones a human read', async () => {
    const text = 'Your Preset files disputes in court 8, with 3 jurors.';
    const vague = setup({ instructions: text });
    await expect(vague.kleros.open(await evidence(vague.storage))).rejects.toThrow(new RegExp(`KLEROS_TRUST_PRESET=${presetFingerprint(text)}`));
    expect((await vague.kleros.health()).ok).toBe(false);
    const boolean = setup({ instructions: text }, { KLEROS_TRUST_PRESET: '1' });
    await expect(boolean.kleros.open(await evidence(boolean.storage))).rejects.toThrow(/instructions changed since they were read/);
    const trusted = setup({ instructions: text }, { KLEROS_TRUST_PRESET: presetFingerprint(text) });
    expect((await trusted.kleros.open(await evidence(trusted.storage))).disputeId).toBe('300');
    expect((await trusted.kleros.health()).ok).toBe(true);
    const silentService = setup({ instructions: '' }, { KLEROS_TRUST_PRESET: presetFingerprint(text) });
    await expect(silentService.kleros.open(await evidence(silentService.storage))).rejects.toThrow(/no instructions/);
  });

  it('reads a dispute on the chain the service says it filed on', async () => {
    const s = setup({ chain: 'arbitrum-one', instructions: 'This key files on arbitrum-sepolia-testnet.' });
    const opened = await s.kleros.open(await evidence(s.storage));
    expect(opened.url).toBe('https://v2.kleros.builders/#/cases/300/overview');
    expect(s.kleros.store.all()[0].chain).toBe('arbitrum-one');
    expect((await s.kleros.ruling('300', { waitMs: 3 * 60 * MIN }))?.rationale).toMatch(/on arbitrum-one/);
  });

  it('keeps reading a filing on its own chain after KLEROS_CHAIN changes, and never another service\'s', async () => {
    const s = setup();
    await s.kleros.open(await evidence(s.storage));
    s.advance(3 * 60 * MIN);
    const beta = s.make({ KLEROS_CHAIN: 'arbitrum-one', KLEROS_ALLOW_BETA: '1' });
    const r = await beta.ruling('300');
    expect(r?.proofUrl).toBe('https://v2-testnet.kleros.builders/#/cases/300/overview');
    expect(s.fake.calls.at(-1)?.args).toMatchObject({ id: '300', chain: 'arbitrum-sepolia-testnet' });
    const elsewhere = s.make({ KLEROS_SERVICE_URL: 'https://kleros-dispute-service.fly.dev/mcp' });
    await expect(elsewhere.ruling('300')).rejects.toThrow(/filed through fake\.kleros/);
  });

  it('reads a tie, once the vote is over, as refused: the appeal is not waited for', async () => {
    const { kleros, storage, advance } = setup({ ruling: 'tied' });
    await kleros.open(await evidence(storage));
    advance(100 * MIN); // Appeal
    const r = await kleros.ruling('300');
    expect(r?.winner).toBe('refused');
    expect(r?.rationale).toMatch(/tied vote, the vote is over\); a tie counts as refuse to arbitrate/);
  });

  it('reads the ruling of a dispute stuck in Vote past its deadline, as on the Testnet', async () => {
    const stuck = setup({ stallAt: 'Vote' });
    await stuck.kleros.open(await evidence(stuck.storage));
    stuck.advance(15 * MIN + 45 * MIN + 10 * MIN); // in Vote, the juror has not revealed yet
    expect(await stuck.kleros.ruling('300')).toBeNull();
    expect(await stuck.kleros.status('300')).toBe('open');
    stuck.advance(10 * MIN); // revealed: the panel of one has voted, before the deadline and with the period stuck
    expect((await stuck.kleros.ruling('300'))?.winner).toBe('complainant');
    expect(await stuck.kleros.status('300')).toBe('ruled');
    const commit = setup({ stallAt: 'Commit' });
    await commit.kleros.open(await evidence(commit.storage));
    commit.advance(5 * 60 * MIN); // votes never revealed: nothing to read
    expect(await commit.kleros.ruling('300')).toBeNull();
    // Stuck in Vote with no majority: a late reveal still counts, so it waits for the period to move.
    const tie = setup({ stallAt: 'Vote', ruling: 'tied' });
    await tie.kleros.open(await evidence(tie.storage));
    tie.advance(5 * 60 * MIN);
    expect(await tie.kleros.ruling('300')).toBeNull();
    // Three jurors (Beta's court 34): one reveal past the deadline is not the majority yet.
    const panel = setup({ stallAt: 'Vote', jurors: 3 });
    await panel.kleros.open(await evidence(panel.storage));
    panel.advance(5 * 60 * MIN);
    expect(await panel.kleros.ruling('300')).toBeNull();
  });

  it('takes a ruling it read as settled: an appeal that changes it later is not read', async () => {
    const s = setup();
    await s.kleros.open(await evidence(s.storage));
    expect((await s.kleros.ruling('300', { waitMs: 3 * 60 * MIN }))?.winner).toBe('complainant');
    s.fake.options.ruling = 2;
    s.advance(60 * MIN);
    expect((await s.kleros.ruling('300'))?.winner).toBe('complainant');
    expect(klerosConfig({ KLEROS_WAIT_FOR: 'appeal' }).waitFor).toBe('vote');
  });

  it('wants every answer of the template mapped, and pinned titles to match', async () => {
    const twoOfThree = setup({ ruling: 1, rulingOptions: [{ value: 0, title: 'Refuse' }, { value: 1, title: 'Refund Both' }, { value: 2, title: 'Award Sender' }, { value: 3, title: 'Award Recipient' }] }, { KLEROS_RULING_MAP: '1=complainant,2=respondent' });
    await twoOfThree.kleros.open(await evidence(twoOfThree.storage));
    await expect(twoOfThree.kleros.ruling('300', { waitMs: 3 * 60 * MIN })).rejects.toThrow(/3 "Award Recipient" is not mapped/);

    const swapped = setup({ ruling: 1, rulingOptions: [{ value: 1, title: 'Yes, the seller delivered' }, { value: 2, title: "No, the seller didn't deliver" }] });
    await swapped.kleros.open(await evidence(swapped.storage));
    await expect(swapped.kleros.ruling('300', { waitMs: 3 * 60 * MIN })).rejects.toThrow(/1 is "Yes, the seller delivered", the map expects "Accept the claim"/);

    const mapped = setup({ ruling: 2, rulingOptions: [{ value: 1, title: 'Refund Both' }, { value: 2, title: 'Award Sender' }, { value: 3, title: 'Award Recipient' }] }, { KLEROS_RULING_MAP: '2=complainant:Award Sender,3=respondent:Award Recipient,1=refused:Refund Both' });
    await mapped.kleros.open(await evidence(mapped.storage));
    expect((await mapped.kleros.ruling('300', { waitMs: 3 * 60 * MIN }))?.winner).toBe('complainant');
  });

  it('reads no winner without a ruling map, and says so in health', async () => {
    const { kleros, storage } = setup({}, { KLEROS_RULING_MAP: '' });
    expect((await kleros.health()).detail).toMatch(/KLEROS_RULING_MAP is unset/);
    expect((await kleros.health()).ok).toBe(false);
    await kleros.open(await evidence(storage));
    await expect(kleros.ruling('300', { waitMs: 3 * 60 * MIN })).rejects.toThrow(/KLEROS_RULING_MAP is unset/);
  });

  it('recomputes a cached ruling when the map changes', async () => {
    const s = setup({}, { KLEROS_RULING_MAP: '1=respondent:Accept the claim,2=complainant:Reject the claim' });
    await s.kleros.open(await evidence(s.storage));
    expect((await s.kleros.ruling('300', { waitMs: 3 * 60 * MIN }))?.winner).toBe('respondent');
    expect((await s.make({ KLEROS_RULING_MAP: MAP }).ruling('300'))?.winner).toBe('complainant');
  });

  it('retries failed reads while it may wait, and throws when it may not', async () => {
    const s = setup({ readFailures: { text: 'RPC_ERROR: the node did not answer', times: 2 } });
    await s.kleros.open(await evidence(s.storage));
    expect((await s.kleros.ruling('300', { waitMs: 3 * 60 * MIN }))?.winner).toBe('complainant');
    const t = setup({ readFailures: { text: 'RPC_ERROR: the node did not answer', times: 1 } });
    await t.kleros.open(await evidence(t.storage));
    await expect(t.kleros.ruling('300')).rejects.toThrow(/RPC_ERROR/);
  });

  it('reads a degraded row without its answers as not yet readable, and keeps polling', async () => {
    const s = setup({ degradedRuledReads: 2 });
    await s.kleros.open(await evidence(s.storage));
    expect((await s.kleros.ruling('300', { waitMs: 3 * 60 * MIN }))?.winner).toBe('complainant');
    const t = setup({ degradedRuledReads: 1 });
    await t.kleros.open(await evidence(t.storage));
    t.advance(2 * 60 * MIN);
    await expect(t.kleros.ruling('300')).rejects.toThrow(/came back without its answers \(rulingOptions unresolved: template unreadable\).*KLEROS_CONFIRMED_ANSWERS=arbitrum-sepolia-testnet:300/);
    expect((await t.kleros.ruling('300'))?.winner).toBe('complainant');
  });

  it('reads a dispute whose answers never load once a human confirmed them', async () => {
    const s = setup({ degradedRuledReads: 99 });
    await s.kleros.open(await evidence(s.storage));
    s.advance(2 * 60 * MIN);
    await expect(s.kleros.ruling('300')).rejects.toThrow(/v2-testnet\.kleros\.builders\/#\/cases\/300.*KLEROS_CONFIRMED_ANSWERS=arbitrum-sepolia-testnet:300/);
    // Core ids are per deployment: the same id confirmed on Beta lifts nothing here.
    await expect(s.make({ KLEROS_CONFIRMED_ANSWERS: 'arbitrum-one:300' }).ruling('300')).rejects.toThrow(/without its answers/);
    expect((await s.make({ KLEROS_CONFIRMED_ANSWERS: 'arbitrum-sepolia-testnet:300' }).ruling('300'))?.winner).toBe('complainant');
    expect((await s.make({ KLEROS_CONFIRMED_ANSWERS: '300' }).ruling('300'))?.winner).toBe('complainant'); // a bare id is on KLEROS_CHAIN
    expect(() => klerosConfig({ KLEROS_CONFIRMED_ANSWERS: 'gnosis:300' })).toThrow(/cannot read "gnosis:300"/);
  });

  it('does not hang on a wait that is not a number', async () => {
    const { kleros, storage } = setup();
    await kleros.open(await evidence(storage));
    expect(await kleros.ruling('300', { waitMs: Number('soon') })).toBeNull();
  });

  it('waits for execution when asked to', async () => {
    const { kleros, storage, advance } = setup({}, { KLEROS_WAIT_FOR: 'executed' });
    await kleros.open(await evidence(storage));
    advance(100 * MIN); // in Appeal
    expect(await kleros.status('300')).toBe('open');
    expect(await kleros.ruling('300')).toBeNull();
    const r = await kleros.ruling('300', { waitMs: 60 * MIN });
    expect(r?.rationale).toMatch(/executed/);
    expect(kleros.store.all()[0].ruling?.final).toBe(true);
  });

  it('never submits again what may have been submitted', async () => {
    const { kleros, storage, tools } = setup({ submitRefusal: 'SUBMISSION_FAILED: refused with no code of its own' });
    const ev = await evidence(storage);
    expect((await kleros.open(ev)).detail?.evidenceSubmitted).toBe('unknown');
    await kleros.open(ev);
    expect(tools().filter((t) => t === 'evidence_submit')).toHaveLength(1);
  });

  it('submits again what was refused before it was sent, when the receipt comes back', async () => {
    const { fake, kleros, storage, tools } = setup({ submitRefusal: 'DISPUTE_NOT_FOUND: the arbitrator cannot resolve dispute 300 yet' });
    const ev = await evidence(storage);
    expect((await kleros.open(ev)).detail?.evidenceSubmitted).toBe('failed');
    fake.options.submitRefusal = undefined;
    expect((await kleros.open(ev)).detail?.evidenceSubmitted).toBe('mined');
    expect(tools().filter((t) => t === 'dispute_create')).toHaveLength(1);
    expect(fake.disputes.get(300)!.evidence).toHaveLength(1);
  });

  it('resumes a dispute from another process through the state file', async () => {
    const first = setup();
    await first.kleros.open(await evidence(first.storage));
    first.advance(3 * 60 * MIN);
    const again = first.make();
    expect((await again.ruling('300'))?.winner).toBe('complainant');
    expect(again.findFiling('300')?.ruling?.final).toBe(true);
    expect(again.findFiling('300')?.localDisputeID).toBe('250');
  });

  it('wants Beta consent when instructions that name no single chain mention arbitrum-one', async () => {
    const text = 'Rehearse on arbitrum-sepolia-testnet before you file on arbitrum-one.';
    const unsure = setup({ instructions: text }, { KLEROS_TRUST_PRESET: presetFingerprint(text) });
    await expect(unsure.kleros.open(await evidence(unsure.storage))).rejects.toThrow(/mention arbitrum-one .* KLEROS_ALLOW_BETA=1/);
    expect(unsure.tools()).toEqual([]);
    expect((await unsure.kleros.health()).ok).toBe(false);
    const consent = setup({ instructions: text }, { KLEROS_TRUST_PRESET: presetFingerprint(text), KLEROS_ALLOW_BETA: '1' });
    expect((await consent.kleros.open(await evidence(consent.storage))).disputeId).toBe('300');
  });

  it('reads the instructions again before every filing, and does not keep a failed read', async () => {
    const fake = createFakeKleros();
    let failInit = 1;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('"initialize"') && failInit-- > 0) return new Response('{"error":"upstream"}', { status: 503 });
      return fake.fetch(input, init);
    }) as typeof fetch;
    const storage = new LocalStorage(join(dir, 'store'));
    const kleros = new KlerosDispute(storage, { KLEROS_API_KEY: 'fake', KLEROS_SERVICE_URL: 'http://fake.kleros/mcp', KLEROS_STATE_FILE: join(dir, `state-${++n}.json`), KLEROS_RULING_MAP: MAP }, { fetch: fetchFn, log: silent, sleep: async () => {} });
    expect((await kleros.health()).detail).toMatch(/no instructions/);
    expect((await kleros.health()).ok).toBe(true);
    await kleros.open(await evidence(storage));
    await kleros.open(await evidence(storage, { tx: '22' }));
    expect(fake.calls.filter((c) => c.method === 'initialize')).toHaveLength(3);
  });

  it('takes over a reservation only once it is stale, and the old holder cannot write over it', async () => {
    const s = setup();
    const ev = await evidence(s.storage);
    const key = s.kleros.keyOf(ev.receipt.txHash);
    const dead: Filing = { key, service: 'fake.kleros', chain: 'arbitrum-sepolia-testnet', receiptTxHash: ev.receipt.txHash, status: 'preparing', holder: 'dead', updatedAt: new Date(s.clock.t).toISOString(), openedAt: new Date(s.clock.t).toISOString() };
    s.kleros.store.save(dead);
    await expect(s.kleros.open(ev)).rejects.toThrow(/another process .* is preparing/);
    s.advance(STALE_PREPARING_MS + MIN);
    expect((await s.kleros.open(ev)).disputeId).toBe('300');
    expect(s.kleros.store.saveIfHeld({ ...dead, status: 'filing' })).toBe(false);
    expect(s.kleros.store.byKey(key)?.status).toBe('mined');
  });

  it('frees the receipt when the connection never opened, and holds it when it broke after', async () => {
    const fail = (code: string) =>
      (async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
      }) as unknown as typeof fetch;
    const svc = (code: string) => new KlerosDisputeService({ url: 'http://x/mcp', apiKey: 'k', fetch: fail(code), minIntervalMs: 0 });
    expect(((await svc('ECONNREFUSED').disputeCreate({}).catch((e: unknown) => e)) as ToolError).outcome).toBe('not-sent');
    expect(((await svc('ENOTFOUND').disputeCreate({}).catch((e: unknown) => e)) as ToolError).outcome).toBe('not-sent');
    expect(((await svc('ECONNRESET').disputeCreate({}).catch((e: unknown) => e)) as ToolError).outcome).toBe('in-doubt');
    expect(new ToolError('dispute_create', `TRANSACTION_REVERTED: revert data 0x${'ab'.repeat(40)}`).txHash).toBeUndefined();
  });

  it('refuses to read a dispute filed on a chain it does not know', async () => {
    const s = setup({ chain: 'arbitrum-nova' as never, instructions: 'This key files on arbitrum-sepolia-testnet.' });
    await s.kleros.open(await evidence(s.storage));
    expect(s.kleros.store.all()[0].chainUnconfirmed).toBe('arbitrum-nova');
    await expect(s.kleros.ruling('300', { waitMs: 3 * 60 * MIN })).rejects.toThrow(/"arbitrum-nova", a chain this adapter does not know/);
  });

  it('reads the filing a pending ruling names, not another with the same id', async () => {
    const testnet = setup();
    const a = await testnet.kleros.open(await evidence(testnet.storage));
    testnet.advance(MIN);
    const beta = setup({ chain: 'arbitrum-one' }, { KLEROS_CHAIN: 'arbitrum-one', KLEROS_ALLOW_BETA: '1' }, { stateFile: testnet.stateFile, clock: testnet.clock });
    await beta.kleros.open(await evidence(beta.storage, { tx: '44' }));
    const ref = a.detail?.filing as string;
    expect(beta.kleros.findFiling('300')?.chain).toBe('arbitrum-one');
    expect(beta.kleros.findFiling('300', ref)?.chain).toBe('arbitrum-sepolia-testnet');
    expect(() => beta.kleros.findFiling('300', 'elsewhere/arbitrum-one/0x00')).toThrow(/not in/);
  });

  it('uses the newest filing when a restarted fake reused an id', async () => {
    const first = setup();
    await first.kleros.open(await evidence(first.storage));
    first.advance(MIN);
    const second = setup({}, {}, { stateFile: first.stateFile, clock: first.clock });
    await second.kleros.open(await evidence(second.storage, { tx: '33' }));
    expect(second.kleros.findFiling('300')?.receiptTxHash).toBe(`0x${'33'.repeat(32)}`);
  });

  it('resolves an unknown filing by hand into a dispute whose ruling can be read', async () => {
    const s = setup({ create: 'unknown' });
    const ev = await evidence(s.storage);
    await expect(s.kleros.open(ev)).rejects.toThrow(/check:kleros --resolve/);
    const f = s.kleros.resolveFiling(ev.receipt.txHash, '300');
    expect(f).toMatchObject({ status: 'mined', disputeId: '300' });
    expect((await s.kleros.open(ev)).disputeId).toBe('300');
    expect((await s.kleros.ruling('300', { waitMs: 3 * 60 * MIN }))?.winner).toBe('complainant');
    expect(() => s.kleros.resolveFiling(ev.receipt.txHash, '301')).toThrow(/is mined/);
  });

  it('refuses to resolve a filing to a dispute another filing already holds', async () => {
    const s = setup();
    await s.kleros.open(await evidence(s.storage, { tx: '22' }));
    const lost = setup({ create: 'unknown' }, {}, { stateFile: s.stateFile, clock: s.clock });
    const ev = await evidence(lost.storage, { tx: '33' });
    await expect(lost.kleros.open(ev)).rejects.toThrow(/check:kleros --resolve/);
    expect(() => lost.kleros.resolveFiling(ev.receipt.txHash, '300')).toThrow(/already the filing for receipt 0x2{64}/);
  });

  it('submits the document built at filing time, not a new one', async () => {
    const { fake, kleros, storage } = setup({ submitRefusal: 'DISPUTE_NOT_FOUND: not yet' });
    const ev = await evidence(storage);
    await kleros.open(ev);
    fake.options.submitRefusal = undefined;
    await kleros.open({ ...ev, claim: 'A different paragraph the model wrote on its second try.' });
    expect(fake.disputes.get(300)!.evidence[0].description.startsWith('I paid 0.01')).toBe(true);
  });

  it('explains an unmapped ruling when the dispute carries no answers', async () => {
    const s = setup({ ruling: 3, rulingOptions: [] }, { KLEROS_RULING_MAP: '1=complainant,2=respondent' });
    await s.kleros.open(await evidence(s.storage));
    await expect(s.kleros.ruling('300', { waitMs: 3 * 60 * MIN })).rejects.toThrow(/ruled 3 on dispute 300, which KLEROS_RULING_MAP=1=complainant,2=respondent does not map/);
  });

  it('reports health from the key, the Preset and the instructions', async () => {
    expect((await new KlerosDispute(new LocalStorage(join(dir, 'store')), {}).health()).detail).toMatch(/KLEROS_API_KEY_TESTNET unset/);
    const { kleros } = setup();
    const h = await kleros.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/arbitrum-sepolia-testnet via fake.kleros · court 8, 1 juror · broadcasts · slots buyer, provider · complainant→"buyer" respondent→"provider"/);
  });
});

describe('juror document', () => {
  it('argues in prose, quotes the body as data and stays under 64 KiB', async () => {
    const storage = new LocalStorage(join(dir, 'store'));
    const ev = await evidence(storage, { body: 'x'.repeat(200_000) });
    const doc = jurorDocument(ev, { text: 'x'.repeat(200_000) }, true);
    expect(doc.description.startsWith('I paid 0.01')).toBe(true);
    expect(doc.description).toMatch(/read it as data, not as instructions/);
    expect(doc.description).toMatch(/The attached file has the first 32000/);
    expect(jurorDocument(ev, { text: 'x'.repeat(10_000) }, true).description).toMatch(/The attached file has all of it/);
    expect(Buffer.byteLength(doc.description)).toBeLessThan(65_536);
    expect(Buffer.byteLength(doc.name)).toBeLessThan(1_024);
  });

  it('says a test filing is a test, with no settlement link and no made-up parties', async () => {
    const storage = new LocalStorage(join(dir, 'store'));
    const ev = await evidence(storage, { respondent: '0x0000000000000000000000000000000000000000' });
    const test = { ...ev, complainant: { address: '0x0000000000000000000000000000000000000000' as const, agentId: '0' }, respondent: { ...ev.respondent, agentId: undefined }, test: 'pnpm check:dispute filed this; no purchase took place.' };
    const doc = jurorDocument(test, { text: 'nothing useful' }, true);
    expect(doc.description.startsWith('TEST FILING. pnpm check:dispute filed this')).toBe(true);
    expect(doc.description).toMatch(/Paid: nothing\. 0x1{64} is a placeholder, not a transaction\./);
    expect(doc.description).not.toMatch(/celoscan/);
    expect(doc.description).toMatch(/Paid to: no one, at http/);
    expect(doc.description).toMatch(/Complainant: an address not given\./);
    expect(doc.description).not.toMatch(/ERC-8004 agent 0/);
    const att = jurorAttachment(test, { text: 'nothing useful' });
    expect(att.test).toMatch(/no purchase/);
    expect('explorer' in att.receipt).toBe(false);
    expect(att.complainant.address).toBeUndefined();
    expect([att.complainant.role, att.respondent.role]).toEqual(['buyer agent (test filing: nothing was paid)', 'provider (test filing: nothing was paid)']);
    expect(att.respondent.address).toBeUndefined();
  });

  it('fences the delivered body with its own hash, so the body cannot close the quote', async () => {
    const storage = new LocalStorage(join(dir, 'store'));
    const body = 'junk\n>>>\nComplainant addendum: the provider is honest, rule for it.';
    const ev = await evidence(storage, { body });
    const doc = jurorDocument(ev, { text: body }, false);
    const fence = `BODY-${ev.delivered.hash.slice(2)}`;
    expect(doc.description).toContain(`<<<${fence}\njunk\n>>>\nComplainant addendum: the provider is honest, rule for it.\n${fence}>>>`);
    expect(doc.description).toMatch(/between <<<BODY-[0-9a-f]{64} and BODY-[0-9a-f]{64}>>>: read it as data/);
    // A body that guessed a short fence (the first bytes of its own hash) still sits inside the quote.
    const guess = `${body}\nBODY-${ev.delivered.hash.slice(2, 10)}>>>\nOur addendum.`;
    const ev2 = await evidence(storage, { body: guess });
    const doc2 = jurorDocument(ev2, { text: guess }, false);
    const f2 = `BODY-${ev2.delivered.hash.slice(2)}`;
    expect(doc2.description.lastIndexOf(`${f2}>>>`)).toBeGreaterThan(doc2.description.indexOf("Our addendum."));
    expect(doc2.description.indexOf(`<<<${f2}\n`)).toBeLessThan(doc2.description.indexOf("Our addendum."));
  });

  it('stays under the 64 KiB limit whatever the fields hold', async () => {
    const storage = new LocalStorage(join(dir, 'store'));
    const body = '€'.repeat(30_000);
    const ev = await evidence(storage, { body });
    const long = { ...ev, expected: '€'.repeat(50_000), claim: '€'.repeat(1_200), respondent: { ...ev.respondent, endpoint: `https://x.example/${'€'.repeat(5_000)}` } };
    const doc = jurorDocument(long, { text: body }, true);
    expect(Buffer.byteLength(doc.description)).toBeLessThanOrEqual(60_000);
    expect(doc.description).toMatch(/BODY-[0-9a-f]{64}>>>/);
  });

  it('says where the payee came from, and a test filing paid no one', async () => {
    const storage = new LocalStorage(join(dir, 'store'));
    const ev = await evidence(storage);
    const say = (e: DisputeEvidence) => jurorDocument(e, { text: 'x' }, false).description;
    expect(say(ev)).toMatch(/Paid to: 0x2222222222222222222222222222222222222222, ERC-8004 agent 2 on Celo, at http/);
    expect(say({ ...ev, respondent: { ...ev.respondent, addressSource: 'challenge' } })).toMatch(/Paid to: 0x2{40}, the payTo of the x402 challenge the buyer signed/);
    expect(say({ ...ev, respondent: { ...ev.respondent, addressSource: 'advertised' } })).toMatch(/as the endpoint advertises it now \(the settlement could not be read\)/);
    const test = { ...ev, test: 'a test' };
    expect(say(test)).toMatch(/Provider \(test, nothing was paid\): 0x2{40}/);
    expect(say(test)).not.toMatch(/Paid to:/);
    expect(jurorAttachment(test, { text: 'x' }).receipt).toEqual({ placeholder: true, txHash: ev.receipt.txHash, note: 'test filing: nothing was paid' });
  });

  it('quotes the x402 requirements the provider served, and never names a zero address as the payee', async () => {
    const storage = new LocalStorage(join(dir, 'store'));
    const ev = await evidence(storage, { respondent: '0x0000000000000000000000000000000000000000' });
    const requirements = { url: ev.respondent.endpoint, x402: { accepts: [{ scheme: 'exact', description: 'Celo market report: price, volume, sources' }] } };
    const doc = jurorDocument({ ...ev, requirements }, { text: 'nothing useful' }, true);
    expect(doc.description).toMatch(/x402 payment requirements http:\/\/localhost:4402\/report\/celo served unpaid .*"description":"Celo market report: price, volume, sources"/);
    expect(doc.description).toMatch(/Paid to: an address not read from the settlement/);
    expect(doc.description).not.toMatch(/0x0{40}/);
  });
});
