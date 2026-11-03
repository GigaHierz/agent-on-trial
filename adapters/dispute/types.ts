import type { Address, Hex } from 'viem';
import type { StoredRef } from '../storage/types.js';

export interface DisputeEvidence {
  complainant: { address: Address; agentId: string };
  respondent: {
    address: Address;
    agentId?: string;
    endpoint: string;
    /** Where the address came from: the settlement on Celo, the x402 challenge the buyer signed, our own config, or the endpoint's advert now. */
    addressSource?: 'settlement' | 'challenge' | 'ours' | 'advertised';
  };
  receipt: {
    txHash: Hex;
    /** In whole tokens, e.g. "0.01". */
    amount: string;
    /** e.g. "USD₮", when the token is one we know. */
    symbol?: string;
    /** The amount as the receipt records it, in the token's smallest unit, e.g. "10000". */
    amountAtomic?: string;
    asset: Address;
    network: 'eip155:42220';
    receiptRef: StoredRef;
  };
  /** The spec the buyer paid for, in words. */
  expected: string;
  /** The x402 payment requirements the endpoint served unpaid when the dispute was filed: the provider's own words. */
  requirements?: { url: string; x402: unknown };
  /** What came back, stored verbatim. */
  delivered: StoredRef;
  /** The complainant's memory head at the time, if any. */
  memory?: StoredRef;
  /** One paragraph from the complainant. */
  claim: string;
  /** Set by pnpm check:dispute, which buys nothing: told to the jurors first, and no feedback is ever written from it. */
  test?: string;
}

export type DisputeStatus = 'open' | 'evidence' | 'ruled' | 'closed';

export interface Ruling {
  winner: 'complainant' | 'respondent' | 'refused';
  rationale: string;
  ruledAt: string;
  /** The ruling document, stored. */
  ref?: StoredRef;
  /** e.g. a Kleros disputeID */
  externalId?: string;
  /** e.g. an Arbiscan tx or a Kleros court URL */
  proofUrl?: string;
}

/**
 * The dispute plug-in. Kleros implements it in adapters/dispute/kleros.ts, over
 * the Kleros Dispute Service client in kleros-service.ts.
 * `pnpm check:dispute` proves it works.
 *
 * Rules:
 * - Adapters never sign Celo transactions. The step scripts write the ERC-8004
 *   ruling feedback from what ruling() returns.
 * - open() must store the evidence somewhere a juror can read it and return
 *   its uri. The storage adapter is handed in for that.
 * - ruling() returns null while pending.
 */
export interface DisputeAdapter {
  readonly name: 'local' | 'kleros';
  /**
   * `uri`/`gatewayUrl`: the stored dispute file. `url`: where a human follows the
   * case (a court page), when that is not the file. `detail` goes on the exhibit as is.
   */
  open(evidence: DisputeEvidence): Promise<{ disputeId: string; uri: string; gatewayUrl?: string; url?: string; detail?: Record<string, unknown> }>;
  /** `ref`: the adapter's own id for the filing (open()'s detail.filing), when dispute ids are not unique. */
  status(disputeId: string, opts?: { ref?: string }): Promise<DisputeStatus>;
  /** quiet: a background poll that throttles its own warnings; the adapter keeps a failed read to itself. */
  ruling(disputeId: string, opts?: { waitMs?: number; ref?: string; quiet?: boolean }): Promise<Ruling | null>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
