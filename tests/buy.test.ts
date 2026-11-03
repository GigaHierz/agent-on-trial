import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// lib/env reads BUY_HOME once, when it is first imported: here, below.
const home = mkdtempSync(join(tmpdir(), 'trial-buy-'));
process.env.BUY_HOME = home;
const { paidAmount, readReceipts, receiptsSince } = await import('../lib/buy.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

const receipt = (id: string, timestamp: number) => ({ id, url: 'http://localhost:4402/report/celo', network: 'eip155:42220', asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', amount: '10000', txHash: `0x${id.repeat(64).slice(0, 64)}`, timestamp });

describe('buy receipts', () => {
  it('reads the newest versioned file, as buy 0.8 writes them, before the legacy receipts.json', () => {
    expect(readReceipts()).toEqual([]);
    writeFileSync(join(home, 'receipts.json'), JSON.stringify([receipt('a', 1)]));
    expect(readReceipts().map((r) => r.id)).toEqual(['a']);
    writeFileSync(join(home, 'receipts.1.json'), JSON.stringify([receipt('b', 2)]));
    writeFileSync(join(home, 'receipts.2.json'), JSON.stringify([receipt('b', 2), receipt('c', Date.now())]));
    writeFileSync(join(home, 'receipts.10.json'), '{"half written');
    expect(readReceipts().map((r) => r.id)).toEqual(['b', 'c']);
    expect(receiptsSince(Date.now() - 60_000).map((r) => r.id)).toEqual(['c']);
  });

  it('shows an amount in whole tokens, keeping the smallest unit', () => {
    expect(paidAmount('10000', '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e')).toEqual({ amount: '0.01', symbol: 'USD₮', amountAtomic: '10000', label: '0.01 USD₮' });
    expect(paidAmount('10000', 'USDT').label).toBe('0.01 USD₮');
    expect(paidAmount('0.01', 'USDT')).toEqual({ amount: '0.01', symbol: 'USD₮', label: '0.01 USD₮' });
    expect(paidAmount('5', '0x1111111111111111111111111111111111111111').label).toBe('5 0x1111111111111111111111111111111111111111');
  });
});
