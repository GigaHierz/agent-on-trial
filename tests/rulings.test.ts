import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseError, EstimateGasExecutionError, HttpRequestError, TimeoutError } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActContext } from '../agent/context.js';
import type { Ruling } from '../adapters/dispute/types.js';

// recordRuling signs on Celo: the signer, the RPC and everything the act imports are stand-ins here.
const { writeFeedback, getTransactionReceipt } = vi.hoisted(() => ({ writeFeedback: vi.fn(), getTransactionReceipt: vi.fn() }));
vi.mock('../lib/feedback.js', () => ({ writeFeedback }));
vi.mock('../lib/clients.js', () => ({ publicClient: { getTransactionReceipt } }));
vi.mock('../lib/log.js', () => ({ log: { host: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), tx: vi.fn() }, flushLog: vi.fn() }));
vi.mock('../agent/loop.js', () => ({ runAct: vi.fn() }));
vi.mock('../agent/cross.js', () => ({ crossExamine: vi.fn() }));
vi.mock('../shady-provider/gate.js', () => ({ startShadyGate: vi.fn(), SHADY_REPORT_URL: 'http://localhost:4402/report/celo' }));

const { recordRuling, rulingWritten } = await import('../steps/04-dispute.js');

const home = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'trial-rulings-'));
beforeAll(() => process.chdir(dir));
afterAll(() => {
  process.chdir(home);
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const ref = { uri: 'data:application/json;base64,e30=', hash: `0x${'aa'.repeat(32)}` as `0x${string}`, bytes: 2 };
const tx = (i: number) => `0x${String(i).padStart(2, '0').repeat(32)}`;
const ruling = (winner: Ruling['winner']): Ruling => ({ winner, rationale: `jurors: ${winner}`, ruledAt: '2026-11-02T11:00:00Z', externalId: '300', proofUrl: 'https://v2-testnet.kleros.builders/#/cases/300/overview' });

function pending() {
  return { disputeId: '300', adapter: 'kleros', ref: `fake/arbitrum-sepolia-testnet/0x${++n}`, agentId: '1', shadyAgentId: '2', proof: { fromAddress: '0x1', toAddress: '0x2', chainId: '42220', txHash: tx(9) } };
}

function ctx() {
  const exhibits: { title: string; txHash?: string; kind?: string; detail?: Record<string, unknown> }[] = [];
  return { exhibits, ctx: { evidence: { data: { exhibits }, reload: () => {}, add: (e: (typeof exhibits)[number]) => exhibits.push(e) } } as unknown as ActContext };
}

/** One writeFeedback call: 'ok', 'reject' (refused before broadcast), 'timeout' (signed, no answer), 'estimate' (gas estimate timed out, before signing) or 'wait' (broadcast, receipt wait failed). */
function behave(...steps: ('ok' | 'reject' | 'timeout' | 'estimate' | 'nonce' | 'broadcast' | 'wait' | 'decline')[]) {
  let i = 0;
  writeFeedback.mockImplementation(async (w: { onSigning?: () => void; onSent?: (h: string, r: typeof ref) => void }) => {
    const step = steps[i++] ?? 'ok';
    if (step === 'decline') return null;
    w.onSigning?.();
    if (step === 'reject') throw new BaseError('insufficient funds for gas');
    if (step === 'timeout') throw new TimeoutError({ body: {}, url: 'https://forno.celo.org' });
    if (step === 'estimate') throw new EstimateGasExecutionError(new TimeoutError({ body: {}, url: 'https://forno.celo.org' }), {} as never);
    if (step === 'nonce') throw new HttpRequestError({ url: 'https://forno.celo.org', status: 503, body: { method: 'eth_getTransactionCount', params: [] } });
    if (step === 'broadcast') throw new HttpRequestError({ url: 'https://forno.celo.org', status: 503, body: { method: 'eth_sendRawTransaction', params: [] } });
    const hash = tx(i);
    w.onSent?.(hash, ref);
    if (step === 'wait') throw new Error('timed out waiting for the receipt');
    return { txHash: hash, ref };
  });
}

beforeEach(() => {
  writeFeedback.mockReset();
  getTransactionReceipt.mockReset();
});

describe('ruling record', () => {
  it('writes each half once, across runs', async () => {
    const p = pending();
    const { ctx: c, exhibits } = ctx();
    behave('ok', 'ok');
    await recordRuling(c, p, ruling('complainant'));
    expect(writeFeedback).toHaveBeenCalledTimes(2);
    expect(exhibits.map((e) => e.title)).toEqual(['Ruling on the provider: complainant', 'Ruling on the defendant: complaint upheld']);
    expect(rulingWritten(p)).toBe(true);
    await recordRuling(c, p, ruling('complainant'));
    expect(writeFeedback).toHaveBeenCalledTimes(2);
  });

  it('frees a half the node refused, and writes it on the next run', async () => {
    const p = pending();
    behave('ok', 'reject');
    await expect(recordRuling(ctx().ctx, p, ruling('complainant'))).rejects.toThrow(/insufficient funds/);
    expect(rulingWritten(p)).toBe(false);
    behave('ok');
    await recordRuling(ctx().ctx, p, ruling('complainant'));
    expect(writeFeedback).toHaveBeenCalledTimes(3);
    expect(rulingWritten(p)).toBe(true);
  });

  it('frees a half whose gas estimate failed: nothing was signed', async () => {
    const p = pending();
    behave('ok', 'estimate');
    await expect(recordRuling(ctx().ctx, p, ruling('complainant'))).rejects.toThrow(/estimate/i);
    behave('ok');
    await recordRuling(ctx().ctx, p, ruling('complainant'));
    expect(writeFeedback).toHaveBeenCalledTimes(3);
    expect(rulingWritten(p)).toBe(true);
  });

  it('frees a half whose nonce read failed, and holds one whose broadcast got no answer', async () => {
    const p = pending();
    behave('nonce', 'broadcast');
    await expect(recordRuling(ctx().ctx, p, ruling('complainant'))).rejects.toThrow(/HTTP request failed/);
    behave('ok');
    await recordRuling(ctx().ctx, p, ruling('complainant'));
    expect(writeFeedback).toHaveBeenCalledTimes(3); // the provider half again; the agent half stays in doubt
    expect(writeFeedback.mock.calls[2][0]).toMatchObject({ agentId: '2', tag2: 'complainant-wins' });
    expect(rulingWritten(p)).toBe(false);
  });

  it('writes the buyer half even when the provider half fails, then throws', async () => {
    const p = pending();
    const { ctx: c, exhibits } = ctx();
    behave('reject', 'ok');
    await expect(recordRuling(c, p, ruling('complainant'))).rejects.toThrow(/insufficient funds/);
    expect(exhibits.map((e) => e.title)).toEqual(['Ruling on the defendant: complaint upheld']);
    behave('ok');
    await recordRuling(c, p, ruling('complainant'));
    expect(writeFeedback.mock.calls.map((x) => x[0].tag2)).toEqual(['complainant-wins', 'complaint-upheld', 'complainant-wins']);
    expect(rulingWritten(p)).toBe(true);
  });

  it('never writes again a half that was signed and got no answer', async () => {
    const p = pending();
    behave('ok', 'timeout');
    await expect(recordRuling(ctx().ctx, p, ruling('complainant'))).rejects.toThrow(/took too long/);
    await recordRuling(ctx().ctx, p, ruling('complainant'));
    expect(writeFeedback).toHaveBeenCalledTimes(2);
    expect(rulingWritten(p)).toBe(false);
  });

  it('confirms a broadcast half from its receipt and adds its exhibit, without writing it again', async () => {
    const p = pending();
    behave('ok', 'wait');
    await expect(recordRuling(ctx().ctx, p, ruling('complainant'))).rejects.toThrow(/receipt/);
    getTransactionReceipt.mockResolvedValue({ status: 'success' });
    const { ctx: c, exhibits } = ctx();
    await recordRuling(c, p, ruling('complainant'));
    expect(writeFeedback).toHaveBeenCalledTimes(2);
    expect(exhibits.map((e) => [e.title, e.txHash])).toEqual([
      ['Ruling on the provider: complainant', tx(1)],
      ['Ruling on the defendant: complaint upheld', tx(2)],
    ]);
    expect(rulingWritten(p)).toBe(true);
  });

  it('writes the second half with the ruling already on the first, even after an appeal', async () => {
    const p = pending();
    behave('ok', 'reject');
    await expect(recordRuling(ctx().ctx, p, ruling('complainant'))).rejects.toThrow();
    behave('ok');
    await recordRuling(ctx().ctx, p, ruling('respondent'));
    expect(writeFeedback.mock.calls.at(-1)![0]).toMatchObject({ agentId: '1', value: 100, tag2: 'complaint-upheld' });
  });

  it('does not pin a ruling of which nothing reached the chain', async () => {
    const p = pending();
    behave('decline', 'decline');
    await recordRuling(ctx().ctx, p, ruling('complainant'));
    writeFeedback.mockReset();
    await recordRuling(ctx().ctx, p, ruling('respondent'));
    expect(writeFeedback).not.toHaveBeenCalled();
    expect(rulingWritten(p)).toBe(true);
  });

  it('writes no feedback when the claim is rejected or refused, and notes it once', async () => {
    for (const winner of ['respondent', 'refused'] as const) {
      const p = pending();
      const { ctx: c, exhibits } = ctx();
      await recordRuling(c, p, ruling(winner));
      await recordRuling(c, p, ruling('complainant')); // an appeal later: the first reading stands
      expect(writeFeedback).not.toHaveBeenCalled();
      expect(exhibits.map((e) => e.title)).toEqual([winner === 'respondent' ? 'Ruling: claim rejected, the delivery matched. No feedback written' : 'Ruling: no decision (refused or tied). No feedback written']);
      expect(rulingWritten(p)).toBe(true);
    }
  });

  it('writes only the defendant when the provider has no identity', async () => {
    const p = { ...pending(), shadyAgentId: undefined };
    behave('ok');
    await recordRuling(ctx().ctx, p, ruling('complainant'));
    expect(writeFeedback.mock.calls.map((c) => [c[0].agentId, c[0].tag2, c[0].value])).toEqual([['1', 'complaint-upheld', 100]]);
    expect(rulingWritten(p)).toBe(true);
  });

  it('stops on a broken record instead of reading it as empty', async () => {
    mkdirSync('.runs', { recursive: true });
    writeFileSync('.runs/rulings.json', '{"kleros:x": {"agent": {"state": "done"},}}');
    expect(() => rulingWritten(pending())).toThrow(/not valid JSON/);
    rmSync('.runs/rulings.json');
  });
});

describe('signer lock', () => {
  it('runs two writers on one key one after the other, across awaits', async () => {
    const { withAsyncFileLock } = await import('../lib/filelock.js');
    const order: string[] = [];
    const job = (name: string) =>
      withAsyncFileLock('.runs/signers/0xabc', async () => {
        order.push(`${name} start`);
        await new Promise((r) => setTimeout(r, 300));
        order.push(`${name} end`);
      });
    await Promise.all([job('a'), job('b')]);
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end']);
  });
});
