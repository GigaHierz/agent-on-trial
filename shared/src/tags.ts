/**
 * The feedback vocabulary this demo writes to the ERC-8004 Reputation Registry.
 * tag1 is the event, tag2 the detail. Every entry carries a feedbackURI that
 * points at the evidence file and a feedbackHash that is keccak256 of its bytes.
 */
export const TAGS = {
  /** Witness: the agent did paid work and the payout settled. tag2: askbots-review */
  earned: 'earned',
  /** Witness: the agent paid for a service through x402 and it settled. tag2: x402-exact */
  paid: 'paid',
  /** A client disputes what a provider delivered. tag2: junk-response */
  dispute: 'dispute',
  /** Arbitrator: an upheld complaint. tag2: complainant-wins (provider, -100) | complaint-upheld (buyer, +100). A rejected claim or a refusal writes nothing. */
  ruling: 'ruling',
  /** Jury: the audience verdict. value = percent who trust. tag2: the event name */
  jury: 'jury',
} as const;

export type Tag1 = (typeof TAGS)[keyof typeof TAGS];

/** Tags askbots writes itself (weekly cron, 10-sample floor). Read, never written here. */
export const ASKBOTS_TAGS = {
  tag1: 'askbots',
  tag2: ['paid-acceptance-rate', 'builder-rating', 'excluded-by-builders'],
} as const;
