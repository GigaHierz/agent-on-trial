import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseError, EstimateGasExecutionError, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActContext } from '../agent/context.js';
import type { FakeOptions } from '../checks/kleros-fake.js';

/**
 * Act 4 with DISPUTE=kleros, end to end, with nothing real: the model's turn is
 * scripted, the Kleros Dispute Service is the fake on a fake clock, Celo is a
 * stand-in registry that refuses self-feedback as the real one does, and any
 * other network call is blocked. The real disputeAct, open_dispute tool, Kleros
 * adapter, act:ruling and ruling ledger run. It runs in a temp folder, so .env
 * (and its keys) is never read.
 *
 * pnpm simulate:kleros prints what each scenario sent to Kleros, what the jurors
 * read, what would be written on Celo and the exhibits, and writes
 * .runs/simulation.md.
 */

const SHADY = 'http://localhost:4402/report/celo';
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Address;
const JUNK = '{"report":"Celo market outlook: strong fundamentals. Confidence: high."}';
const KEYS = { agent: `0x${'11'.repeat(32)}`, counterparty: `0x${'22'.repeat(32)}`, arbitrator: `0x${'33'.repeat(32)}`, shady: `0x${'44'.repeat(32)}` } as const;
const MIN = 60_000;

interface Write { signer: string; signerAddress: string; agentId: string; value: number; tag1: string; tag2?: string; toAddress?: string; txHash: string }

const sim = vi.hoisted(() => ({
  lines: [] as string[],
  writes: [] as Write[],
  proofs: [] as { fromAddress?: string; toAddress?: string }[],
  reverts: [] as string[],
  receipts: new Map<string, unknown>(),
  owners: {} as Record<string, string>,
  payTo: '' as string,
  kleros: undefined as unknown,
  runAct: undefined as unknown as (ctx: unknown, act: string) => Promise<string>,
  writeFeedback: undefined as unknown as (w: unknown) => Promise<unknown>,
}));

vi.mock('../lib/log.js', () => {
  const rec = (kind: string) => (...a: unknown[]) => void sim.lines.push(`${kind.padEnd(6)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`);
  return {
    log: { host: rec('host'), agent: rec('agent'), toolCall: rec('call'), toolResult: rec('result'), tx: rec('tx'), info: rec('info'), warn: rec('warn'), error: rec('error'), approve: rec('ok?'), ops: rec('info'), opsWarn: rec('warn'), prompt: rec('host') },
    setMirror: () => {},
    flushLog: async () => {},
    redact: (x: unknown) => x,
    showUri: (uri: string, gatewayUrl?: string) => gatewayUrl ?? uri,
    setLogRound: () => {},
  };
});
vi.mock('../lib/clients.js', () => ({
  publicClient: {
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = sim.receipts.get(hash.toLowerCase());
      if (!r) throw new Error(`simulation: no Celo receipt for ${hash}`);
      return r;
    },
  },
}));
vi.mock('../lib/feedback.js', () => ({ writeFeedback: (w: unknown) => sim.writeFeedback(w) }));
vi.mock('../agent/loop.js', () => ({ runAct: (ctx: unknown, act: string) => sim.runAct(ctx, act) }));
vi.mock('../agent/cross.js', () => ({ crossExamine: async () => {} }));
vi.mock('../shady-provider/gate.js', () => ({ SHADY_REPORT_URL: 'http://localhost:4402/report/celo', startShadyGate: async () => ({ payTo: sim.payTo, stop: async () => {} }) }));
vi.mock('../adapters/dispute/index.js', () => ({ getDispute: () => sim.kleros, makeDispute: () => sim.kleros }));

// A temp folder before anything loads dotenv: no .env, no real keys, no real service.
const home = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'trial-simulate-'));
process.chdir(dir);
for (const k of Object.keys(process.env)) if (/^(KLEROS_|AGENT_|COUNTERPARTY_|ARBITRATOR_|WITNESS_|JURY_|BUILDER_|SHADY_|PRIVATE_KEY|ANTHROPIC_|COURTROOM_|HOST_SECRET|STORAGE|DISPUTE)/.test(k)) delete process.env[k];
Object.assign(process.env, { AGENT_ID: '7', SHADY_AGENT_ID: '9', STORAGE: 'local', DISPUTE: 'kleros' });

const { KlerosDispute } = await import('../adapters/dispute/kleros.js');
const { createFakeKleros } = await import('../checks/kleros-fake.js');
const { getStorage } = await import('../adapters/storage/index.js');
const { EvidenceStore } = await import('../lib/evidence.js');
const { roleAddress } = await import('../lib/env.js');
const { disputeAct } = await import('../steps/04-dispute.js');
const { rulingAct, watchRuling } = await import('../steps/04-ruling.js');
const { disputeTools } = await import('../agent/tools/dispute.js');

const realFetch = globalThis.fetch;
beforeAll(() => {
  // Only the provider's unpaid 402 is answered; the Kleros fake is reached through the adapter's own fetch.
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(SHADY)) {
      const accepts = [{ scheme: 'exact', network: 'eip155:42220', maxAmountRequired: '10000', asset: USDT, payTo: sim.payTo, resource: SHADY, description: 'Celo market report with sections: price, volume, sources', mimeType: 'application/json' }];
      return new Response(JSON.stringify({ x402Version: 1, accepts }), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`simulation: blocked network call to ${url}`);
  });
});

const report: string[] = [];
afterAll(() => {
  vi.stubGlobal('fetch', realFetch);
  process.chdir(home);
  rmSync(dir, { recursive: true, force: true });
  if (process.env.SIMULATE_REPORT !== '1') return;
  const text = `# Act 4 with Kleros: simulation\n\nNothing real: scripted model, fake Kleros Dispute Service, stand-in Celo registry (refuses self-feedback), other network blocked. .env is not read: this checks the code, not your configuration (pnpm preflight does that).\n\nThe fake's periods advance on their own; the Testnet's do not, so a real ruling may take far longer than here, or not come within a session. The rulings below are the best case.\n\n${report.join('\n')}`;
  mkdirSync(join(home, '.runs'), { recursive: true });
  writeFileSync(join(home, '.runs', 'simulation.md'), text);
  console.log(`${text}\n(written to .runs/simulation.md)`);
});

/** The stand-in registry: owner-signed feedback reverts, as giveFeedback does on Celo. */
sim.writeFeedback = async (raw: unknown) => {
  const w = raw as { role: Parameters<typeof roleAddress>[0]; agentId: string; value: number; tag1: string; tag2?: string; proofOfPayment?: { fromAddress?: string; toAddress?: string }; onSigning?: () => void; onSent?: (h: Hex, r: unknown) => void };
  sim.proofs.push({ ...w.proofOfPayment });
  const signer = getAddress(roleAddress(w.role));
  const owner = sim.owners[w.agentId];
  w.onSigning?.();
  if (owner && getAddress(owner) === signer) {
    sim.reverts.push(`${w.role} → agent ${w.agentId}: execution reverted: Self-feedback not allowed`);
    throw new EstimateGasExecutionError(new BaseError('execution reverted: Self-feedback not allowed'), {} as never);
  }
  const ref = await getStorage().put(JSON.stringify({ agentId: w.agentId, value: w.value, tag1: w.tag1, tag2: w.tag2 }), { name: `feedback-${w.tag1}.json` });
  const txHash = keccak256(toHex(`feedback ${sim.writes.length} ${w.agentId} ${w.tag1} ${w.tag2} ${Math.random()}`));
  w.onSent?.(txHash, ref);
  sim.receipts.set(txHash.toLowerCase(), { status: 'success', logs: [] });
  sim.writes.push({ signer: w.role, signerAddress: signer, agentId: w.agentId, value: w.value, tag1: w.tag1, tag2: w.tag2, toAddress: w.proofOfPayment?.toAddress, txHash });
  return { txHash, ref, clientAddress: signer, file: {} };
};

interface Scene {
  name: string;
  fake?: FakeOptions;
  env?: Record<string, string>;
  keys?: Partial<Record<keyof typeof KEYS, string | undefined>>;
  endpoint?: string;
  /** Act identity did not run in this run folder: no agentAddress on the evidence. */
  noIdentity?: boolean;
}

/** One run of act 4 (and act:ruling when asked), from a fresh run folder and a fresh fake. */
async function run(scene: Scene) {
  for (const v of ['AGENT_PRIVATE_KEY', 'COUNTERPARTY_PRIVATE_KEY', 'ARBITRATOR_PRIVATE_KEY', 'SHADY_PRIVATE_KEY']) delete process.env[v];
  const keys = { agent: KEYS.agent, counterparty: KEYS.counterparty, arbitrator: KEYS.arbitrator, ...scene.keys };
  if (keys.agent) process.env.AGENT_PRIVATE_KEY = keys.agent;
  if (keys.counterparty) process.env.COUNTERPARTY_PRIVATE_KEY = keys.counterparty;
  if (keys.arbitrator) process.env.ARBITRATOR_PRIVATE_KEY = keys.arbitrator;
  if (keys.shady) process.env.SHADY_PRIVATE_KEY = keys.shady;
  sim.lines.length = 0;
  sim.writes.length = 0;
  sim.proofs.length = 0;
  sim.reverts.length = 0;
  const agent = roleAddress('agent');
  sim.payTo = roleAddress('shady');
  sim.owners = { '7': agent, '9': sim.payTo }; // shady:register mints the provider's identity from the shady key

  const clock = { t: Date.parse('2026-11-03T10:00:00Z') };
  const now = () => clock.t;
  const sleep = async (ms: number) => void (clock.t += ms);
  const fake = createFakeKleros({ now, ...scene.fake });
  const kleros = new KlerosDispute(
    getStorage(),
    { KLEROS_API_KEY_TESTNET: 'fake', KLEROS_API_KEY_BETA: 'fake', KLEROS_SERVICE_URL: 'http://fake.kleros/mcp', KLEROS_STATE_FILE: `.runs/kleros/${scene.name}.json`, KLEROS_RULING_MAP: '1=complainant:Accept the claim,2=respondent:Reject the claim', ...scene.env },
    { fetch: fake.fetch, now, sleep, log: { info: (t: string) => void sim.lines.push(`info   ${t}`), warn: (t: string) => void sim.lines.push(`warn   ${t}`) } },
  );
  sim.kleros = kleros;

  const tx = keccak256(toHex(`settlement ${scene.name}`));
  sim.runAct = async (c: unknown, act: string) => {
    const ctx = c as ActContext;
    if (act !== 'dispute') throw new Error(`simulation scripts act 4 only, not ${act}`);
    // The model buys the report through buy_curl: what the tool records, then the settlement on Celo.
    const endpoint = scene.endpoint ?? SHADY;
    ctx.artifacts.push({ kind: 'x402_response', url: endpoint, body: `402 challenge: 0.01 USD₮, asset=${USDT}, on eip155:42220, payTo=${sim.payTo}\nSettled on eip155:42220: tx=${tx}\n--- response headers ---\ncontent-type: application/json\n--- response body ---\n${JUNK}` });
    ctx.artifacts.push({ kind: 'x402_receipt', url: endpoint, txHash: tx, amount: '10000', asset: USDT, network: 'eip155:42220', raw: { id: scene.name, url: endpoint, network: 'eip155:42220', asset: USDT, amount: '10000', scheme: 'exact', txHash: tx, authorization: { from: agent, nonce: '0x01', validAfter: '0', validBefore: '9999999999' }, timestamp: new Date().toISOString(), status: 'settled' } });
    sim.receipts.set(tx.toLowerCase(), {
      status: 'success',
      logs: [{ address: USDT, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: agent, to: sim.payTo as Address } }), data: encodeAbiParameters([{ type: 'uint256' }], [10_000n]), blockHash: `0x${'00'.repeat(32)}`, blockNumber: 1n, logIndex: 0, transactionHash: tx, transactionIndex: 0, removed: false }],
    });
    // Then it opens the dispute, as the act 4 prompt asks.
    const [open] = disputeTools(ctx);
    const out = await open.run({
      providerAgentId: '9',
      providerEndpoint: endpoint,
      receiptTxHash: tx,
      expected: 'a Celo market report with sections: price, volume, sources',
      deliveredBody: JUNK,
      claim: 'I paid 0.01 USD₮ for a Celo market report with price, volume and sources. The body has none of them: one sentence of opinion.',
    });
    sim.lines.push(`model  open_dispute → ${typeof out === 'string' ? out : JSON.stringify(out)}`);
    return 'done';
  };

  mkdirSync('.runs', { recursive: true });
  const evidence = EvidenceStore.fresh(`sim-${scene.name}`);
  if (!scene.noIdentity) evidence.setAgent('7', agent);
  const ctx = { evidence, memory: { head: null, entries: [] }, artifacts: [], params: {} } as unknown as ActContext;
  const act = await disputeAct(ctx).then(
    () => undefined,
    (err: Error) => err,
  );
  return { fake, kleros, ctx, clock, act, tx, agent };
}

async function ruling(r: Awaited<ReturnType<typeof run>>, waitMs = 3 * 60 * MIN) {
  return rulingAct(r.ctx, { waitMs }).then(
    () => undefined,
    (err: Error) => err,
  );
}

function describeRun(title: string, r: Awaited<ReturnType<typeof run>>, errors: (Error | undefined)[] = []) {
  const created = [...r.fake.disputes.values()][0];
  const calls = r.fake.calls.filter((c) => c.method === 'tools/call').map((c) => c.tool);
  const out = [`## ${title}`, ''];
  // Consecutive repeats (the ruling polls) as one entry with a count.
  const runs: string[] = [];
  for (let i = 0; i < calls.length; ) {
    let j = i;
    while (j < calls.length && calls[j] === calls[i]) j++;
    runs.push(j - i > 1 ? `${calls[i]} ×${j - i}` : String(calls[i]));
    i = j;
  }
  out.push(`- Kleros calls: ${runs.length ? runs.join(' → ') : 'none'}`);
  if (created) {
    out.push(`- Filed: dispute ${created.core} (arbitrable ${created.local}), aliases ${JSON.stringify(created.aliases)}`);
    const doc = created.evidence[0];
    if (doc) out.push(`- Evidence "${doc.name}" (${Buffer.byteLength(doc.description)} bytes, attachment ${doc.fileUri ?? 'none'}):`, '', '  ```', ...doc.description.split('\n').slice(0, 14).map((l) => `  ${l.slice(0, 200)}`), '  ```');
  }
  out.push(`- Celo writes: ${sim.writes.length ? '' : 'none'}`);
  for (const w of sim.writes) out.push(`  - ${w.signer} (${w.signerAddress.slice(0, 10)}…) → agent ${w.agentId}: ${w.value > 0 ? '+' : ''}${w.value} ${w.tag1}/${w.tag2}${w.toAddress !== undefined ? `, proof to ${w.toAddress || '(none)'}` : ''}`);
  for (const v of sim.reverts) out.push(`  - REVERTED ${v}`);
  out.push(`- Exhibits: ${r.ctx.evidence.data.exhibits.map((e) => `${e.id} ${e.title}`).join(' · ') || 'none'}`);
  const seen = new Map<string, number>();
  for (const l of sim.lines.filter((x) => /^(warn|error)/.test(x))) seen.set(l.slice(0, 260), (seen.get(l.slice(0, 260)) ?? 0) + 1);
  const notable = [...seen].map(([l, n]) => `  - ${l}${n > 1 ? ` (×${n})` : ''}`);
  if (notable.length) out.push('- Warnings and errors:', ...notable);
  for (const e of errors.filter(Boolean)) out.push(`- Command failed: ${e!.message.split('\n')[0].slice(0, 260)}`);
  report.push(out.join('\n'), '');
}

const tags = () => sim.writes.map((w) => `${w.signer}>${w.agentId}:${w.value}:${w.tag1}/${w.tag2}`);

describe('simulation: act 4 with Kleros', () => {
  it('Testnet, jurors accept the claim: nothing written at filing, ruling -100/+100 after act:ruling', async () => {
    const r = await run({ name: 'upheld', keys: { shady: KEYS.shady } });
    expect(r.act).toBeUndefined();
    const filed = [...r.fake.disputes.values()][0];
    expect(filed.aliases).toEqual({ buyer: getAddress(r.agent), provider: getAddress(sim.payTo) });
    const doc = filed.evidence[0].description;
    expect(doc).toMatch(/Paid: 0\.01 USD₮ of token 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e \(10000 in its smallest unit\)/);
    expect(doc).toMatch(/x402 payment requirements http:\/\/localhost:4402\/report\/celo served unpaid/);
    expect(doc).toMatch(new RegExp(`Paid to: ${getAddress(sim.payTo)}, ERC-8004 agent 9 on Celo`));
    expect(tags()).toEqual([]);
    expect(r.ctx.evidence.data.exhibits.some((e) => e.title.startsWith('Ruling pending'))).toBe(true);
    const err = await ruling(r);
    expect(err).toBeUndefined();
    expect(tags()).toEqual(['arbitrator>9:-100:ruling/complainant-wins', 'arbitrator>7:100:ruling/complaint-upheld']);
    expect(sim.writes.every((w) => w.toAddress === getAddress(sim.payTo))).toBe(true);
    describeRun('1. Testnet, three keys, jurors rule 1 "Accept the claim"', r, [err]);
    expect(await ruling(r)).toBeUndefined(); // again: nothing written twice
    expect(sim.writes).toHaveLength(2);
  });

  it('two keys only: the arbitrator owns the provider, so its ruling there reverts; the buyer half still lands', async () => {
    const r = await run({ name: 'two-keys', keys: { arbitrator: undefined } });
    expect(roleAddress('arbitrator')).toBe(sim.payTo);
    const err = await ruling(r);
    expect(err?.message).toMatch(/Self-feedback not allowed/);
    expect(tags()).toEqual(['arbitrator>7:100:ruling/complaint-upheld']);
    describeRun('2. Two keys only (arbitrator = shady owner), jurors rule 1', r, [err]);
    // The fix: a third wallet for the arbitrator. The provider half was never signed, so it is written now.
    process.env.ARBITRATOR_PRIVATE_KEY = KEYS.arbitrator;
    expect(await ruling(r)).toBeUndefined();
    expect(tags().slice(1)).toEqual(['arbitrator>9:-100:ruling/complainant-wins']);
    report.push('   After `ARBITRATOR_PRIVATE_KEY` is set to a third wallet, `act:ruling` writes the provider half (-100 complainant-wins) and nothing twice.', '');
  });

  it('jurors reject the claim: no ruling feedback on either party', async () => {
    const r = await run({ name: 'rejected', fake: { ruling: 2 } });
    const err = await ruling(r);
    expect(err).toBeUndefined();
    expect(tags()).toEqual([]);
    expect(r.ctx.evidence.data.exhibits.some((e) => e.title === 'Ruling: claim rejected, the delivery matched. No feedback written')).toBe(true);
    describeRun('3. Jurors rule 2 "Reject the claim"', r, [err]);
  });

  it('jurors refuse to arbitrate: no ruling feedback', async () => {
    const r = await run({ name: 'refused', fake: { ruling: 0 } });
    const err = await ruling(r);
    expect(err).toBeUndefined();
    expect(tags()).toEqual([]);
    describeRun('4. Jurors rule 0 (refuse to arbitrate)', r, [err]);
  });

  it('the session watch: reads while the jurors vote, writes once the vote is over, only says so in approve mode', async () => {
    const r = await run({ name: 'watched', keys: { shady: KEYS.shady } });
    expect(r.act).toBeUndefined();
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i++) await new Promise((res) => setTimeout(res, 5));
    };
    let work: (() => Promise<void>) | undefined;
    const hooks = (approve: boolean) => ({ whenIdle: (fn: () => Promise<void>) => void (work = fn), approveOn: () => approve });

    const voting = watchRuling(r.ctx, hooks(false))!;
    expect(voting).not.toBeNull();
    await until(() => voting.status() !== 'not read yet');
    expect(voting.status()).toMatch(/still voting/);
    voting.stop();
    expect(work).toBeUndefined();

    r.clock.t += 3 * 60 * MIN; // the vote is over
    const told = watchRuling(r.ctx, hooks(true))!;
    await until(() => work !== undefined);
    const notice = work!;
    await notice();
    told.stop();
    expect(sim.lines.some((l) => /The jurors have voted on dispute/.test(l))).toBe(true);
    expect(tags()).toEqual([]); // approve mode: /act ruling writes it, with the host's y/N

    work = undefined;
    const writes = watchRuling(r.ctx, hooks(false))!;
    await until(() => work !== undefined);
    await work!();
    writes.stop();
    expect(tags()).toEqual(['arbitrator>9:-100:ruling/complainant-wins', 'arbitrator>7:100:ruling/complaint-upheld']);
    expect(watchRuling(r.ctx, hooks(false))).toBeNull(); // nothing pending any more
    // A notice that waited for a command which wrote the ruling meanwhile stays silent.
    const said = sim.lines.filter((l) => /The jurors have voted on dispute/.test(l)).length;
    await notice();
    expect(sim.lines.filter((l) => /The jurors have voted on dispute/.test(l))).toHaveLength(said);
    expect(told.status()).toBe('the ruling is on chain');
  });

  it('a tie, once the vote is over, is refused: no ruling feedback', async () => {
    const r = await run({ name: 'tie', fake: { ruling: 'tied' } });
    const err = await ruling(r);
    expect(err).toBeUndefined();
    expect(tags()).toEqual([]);
    describeRun('5. A tied vote (refused once the vote is over)', r, [err]);
  });

  it('a dispute stuck in Vote past its deadline still gets its ruling written', async () => {
    const r = await run({ name: 'stuck', fake: { stallAt: 'Vote' } });
    const err = await ruling(r);
    expect(err).toBeUndefined();
    expect(tags()).toEqual(['arbitrator>9:-100:ruling/complainant-wins', 'arbitrator>7:100:ruling/complaint-upheld']);
    describeRun('5b. The Testnet never moves the period: the dispute sits in Vote past its deadline', r, [err]);
  });

  it('a filing that times out may exist: nothing is written and nothing is filed again', async () => {
    const r = await run({ name: 'timeout', fake: { create: 'timeout' } });
    expect(sim.writes).toHaveLength(0);
    expect(r.ctx.evidence.data.exhibits.some((e) => e.title.startsWith('Dispute may exist, unresolved'))).toBe(true);
    expect(r.kleros.store.all()[0].status).toBe('unknown');
    describeRun('6. dispute_create times out (FILING_TIMED_OUT): may have been sent', r, [r.act]);
  });

  it('Beta without consent: refused before anything is sent', async () => {
    const r = await run({ name: 'beta', fake: { chain: 'arbitrum-one', court: '34', jurors: 5 }, env: { KLEROS_CHAIN: 'arbitrum-one' } });
    expect(r.fake.calls.filter((c) => c.method === 'tools/call')).toHaveLength(0);
    expect(sim.writes).toHaveLength(0);
    describeRun('7. KLEROS_CHAIN=arbitrum-one without KLEROS_ALLOW_BETA', r, [r.act]);
  });

  it('degraded reads without the answers: not read until a human confirms them', async () => {
    const r = await run({ name: 'degraded', fake: { degradedRuledReads: 999 } });
    const err = await ruling(r);
    expect(err?.message).toMatch(/KLEROS_CONFIRMED_ANSWERS=arbitrum-sepolia-testnet:300/);
    expect(tags()).toEqual([]);
    describeRun('8. The Testnet returns the dispute without its answers', r, [err]);
    sim.kleros = new KlerosDispute(getStorage(), { KLEROS_API_KEY_TESTNET: 'fake', KLEROS_SERVICE_URL: 'http://fake.kleros/mcp', KLEROS_STATE_FILE: '.runs/kleros/degraded.json', KLEROS_RULING_MAP: '1=complainant:Accept the claim,2=respondent:Reject the claim', KLEROS_CONFIRMED_ANSWERS: 'arbitrum-sepolia-testnet:300' }, { fetch: r.fake.fetch, now: () => r.clock.t, sleep: async (ms) => void (r.clock.t += ms), log: { info: () => {}, warn: () => {} } });
    expect(await ruling(r)).toBeUndefined();
    expect(tags()).toEqual(['arbitrator>9:-100:ruling/complainant-wins', 'arbitrator>7:100:ruling/complaint-upheld']);
    report.push('   With `KLEROS_CONFIRMED_ANSWERS=arbitrum-sepolia-testnet:300` (after checking the answers on the Court page), `act:ruling` writes the ruling.', '');
  });

  it('a run where act identity did not run still names the payer in every proof', async () => {
    const r = await run({ name: 'no-identity', noIdentity: true });
    expect(await ruling(r)).toBeUndefined();
    expect(sim.writes).toHaveLength(2);
    expect(sim.proofs.every((p) => p.fromAddress === getAddress(r.agent))).toBe(true);
  });

  it('a busy, rate-limited service still files once', async () => {
    const r = await run({ name: 'busy', fake: { busyWrites: 2, rateLimited: 2 } });
    expect(r.act).toBeUndefined();
    expect(r.fake.disputes.size).toBe(1);
    expect(r.fake.calls.filter((c) => c.tool === 'dispute_create').length).toBeGreaterThanOrEqual(1);
    expect(await ruling(r)).toBeUndefined();
    expect(sim.writes).toHaveLength(2);
    describeRun('9. WRITE_IN_PROGRESS twice and 429 twice on the way', r);
  });
});
