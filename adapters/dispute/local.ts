import { canonicalJson } from '@trial/shared';
import type { StorageAdapter } from '../storage/types.js';
import type { DisputeAdapter, DisputeEvidence, DisputeStatus, Ruling } from './types.js';

interface Open {
  evidence: DisputeEvidence;
  uri: string;
  status: DisputeStatus;
  ruling: Ruling | null;
}

/**
 * The default. Stores the dispute file through the storage adapter and rules
 * deterministically: the spec names required sections; if the delivered body
 * does not contain them, the complainant wins.
 */
export class LocalDispute implements DisputeAdapter {
  readonly name = 'local' as const;
  private readonly open_ = new Map<string, Open>();

  constructor(private readonly storage: StorageAdapter) {}

  async open(evidence: DisputeEvidence) {
    const file = { type: 'agent-on-trial/dispute-v1', openedAt: new Date().toISOString(), ...evidence };
    const stored = await this.storage.put(canonicalJson(file), { name: 'dispute.json' });
    const disputeId = `local-${stored.hash.slice(2, 14)}`;
    this.open_.set(disputeId, { evidence, uri: stored.uri, status: 'open', ruling: null });
    return { disputeId, uri: stored.uri, gatewayUrl: stored.gatewayUrl, url: stored.gatewayUrl };
  }

  async status(disputeId: string): Promise<DisputeStatus> {
    return this.open_.get(disputeId)?.status ?? 'closed';
  }

  async ruling(disputeId: string): Promise<Ruling | null> {
    const d = this.open_.get(disputeId);
    if (!d) throw new Error(`unknown dispute ${disputeId}`);
    if (d.ruling) return d.ruling;
    const delivered = new TextDecoder().decode(await this.storage.get(d.evidence.delivered.uri));
    const missing = requiredSections(d.evidence.expected).filter(
      (s) => !delivered.toLowerCase().includes(s.toLowerCase()),
    );
    const winner = missing.length > 0 ? 'complainant' : 'respondent';
    const rationale =
      winner === 'complainant'
        ? `The buyer paid for ${d.evidence.expected}. The delivered body does not contain: ${missing.join(', ')}.`
        : `The delivered body contains every section the buyer paid for.`;
    const file = { type: 'agent-on-trial/ruling-v1', disputeId, winner, rationale, ruledAt: new Date().toISOString() };
    const ref = await this.storage.put(canonicalJson(file), { name: 'ruling.json' });
    d.ruling = { winner, rationale, ruledAt: file.ruledAt, ref };
    d.status = 'ruled';
    return d.ruling;
  }

  async health() {
    return { ok: true, detail: 'deterministic local arbitrator' };
  }
}

/**
 * "a Celo market report with sections: price, volume, sources" -> [price, volume, sources].
 * Anything after "sections:" (or "with:"), split on commas and "and".
 */
export function requiredSections(expected: string): string[] {
  const m = expected.match(/(?:sections?|with)\s*:\s*(.+)$/i);
  if (!m) return [];
  return m[1]
    .split(/,|\band\b/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean);
}
