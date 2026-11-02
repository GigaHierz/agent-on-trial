import { describe, expect, it } from 'vitest';
import { hasRole, roleAddress, roleKey } from '../lib/env.js';
import { redact } from '../lib/log.js';

const K1 = '0x' + '11'.repeat(32);
const K2 = '0x' + '22'.repeat(32);
const K3 = '0x' + '33'.repeat(32);

describe('role keys', () => {
  it('falls back from role vars to the two Conductor variables', () => {
    const env = { PRIVATE_KEY: K1, PRIVATE_KEY_2: K2 };
    expect(roleKey('agent', env)).toBe(K1);
    expect(roleKey('witness', env)).toBe(K2);
    expect(roleKey('jury', env)).toBe(K2);
    expect(roleKey('builder', env)).toBe(K2);
    expect(roleKey('shady', env)).toBe(K2);
  });

  it('prefers the specific variable when set', () => {
    const env = { PRIVATE_KEY: K1, PRIVATE_KEY_2: K2, WITNESS_PRIVATE_KEY: K3 };
    expect(roleKey('witness', env)).toBe(K3);
    expect(roleKey('arbitrator', env)).toBe(K2);
    expect(roleAddress('witness', env)).toMatch(/^0x/);
  });

  it('accepts keys without the 0x prefix and adds it', () => {
    const env = { PRIVATE_KEY: '11'.repeat(32), PRIVATE_KEY_2: '22'.repeat(32) };
    expect(roleKey('agent', env)).toBe(K1);
    expect(roleKey('counterparty', env)).toBe(K2);
    expect(roleAddress('agent', env)).toBe(roleAddress('agent', { PRIVATE_KEY: K1 }));
  });

  it('reports a missing role instead of guessing', () => {
    expect(hasRole('agent', {})).toBe(false);
    expect(() => roleKey('agent', {})).toThrow(/AGENT_PRIVATE_KEY/);
    expect(hasRole('agent', { PRIVATE_KEY: 'not-a-key' })).toBe(false);
  });
});

describe('log redaction', () => {
  it('hides values under secret-looking keys', () => {
    expect(redact({ apiKey: 'x', Authorization: 'y', url: 'ok', nested: { private_key: 'z' } })).toEqual({
      apiKey: '[redacted]',
      Authorization: '[redacted]',
      url: 'ok',
      nested: { private_key: '[redacted]' },
    });
  });
});
