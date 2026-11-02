import {
  AGENT_REGISTRY,
  CHAIN_ID,
  REPUTATION_REGISTRY,
  REPUTATION_REGISTRY_ABI,
  buildFeedbackFile,
  canonicalJson,
  type ProofOfPayment,
} from '@trial/shared';
import { getAddress, type Address, type Hex } from 'viem';
import { getStorage } from '../adapters/storage/index.js';
import type { StoredRef } from '../adapters/storage/types.js';
import { approve } from './approve.js';
import { publicClient, waitOk, walletFor } from './clients.js';
import type { Role } from './env.js';
import { log, showUri } from './log.js';

export interface FeedbackWrite {
  /** Which key signs. Must not own or operate the agent. */
  role: Role;
  agentId: string;
  value: number;
  valueDecimals?: number;
  tag1: string;
  tag2?: string;
  endpoint: string;
  proofOfPayment?: ProofOfPayment;
  evidence?: Record<string, unknown>;
}

export interface FeedbackResult {
  txHash: Hex;
  ref: StoredRef;
  clientAddress: Address;
  file: ReturnType<typeof buildFeedbackFile>;
}

/**
 * The one place that writes to the Reputation Registry. The evidence file is
 * stored through the storage adapter first, so feedbackURI points at it and
 * feedbackHash is the keccak256 of its bytes. Nothing is signed until the
 * host approves (in --approve mode).
 */
export async function writeFeedback(w: FeedbackWrite): Promise<FeedbackResult | null> {
  const wallet = walletFor(w.role);
  const clientAddress = getAddress(wallet.account.address);
  const file = buildFeedbackFile({
    agentId: w.agentId,
    clientAddress: `eip155:${CHAIN_ID}:${clientAddress}`,
    createdAt: new Date().toISOString(),
    value: w.value,
    valueDecimals: w.valueDecimals ?? 0,
    tag1: w.tag1,
    tag2: w.tag2,
    endpoint: w.endpoint,
    proofOfPayment: w.proofOfPayment,
    evidence: w.evidence,
    agentRegistry: AGENT_REGISTRY,
  });
  const json = canonicalJson(file);
  const ref = await getStorage().put(json, { contentType: 'application/json', name: `feedback-${w.tag1}.json` });
  log.info(`feedback file stored ${showUri(ref.uri, ref.gatewayUrl)} hash ${ref.hash}`);

  const what = `${w.role} writes giveFeedback(agent ${w.agentId}, ${w.value}, ${w.tag1}${w.tag2 ? `/${w.tag2}` : ''})`;
  if (!(await approve(what))) return null;

  log.toolCall('giveFeedback', { agentId: w.agentId, value: w.value, tag1: w.tag1, tag2: w.tag2, endpoint: w.endpoint, feedbackURI: ref.uri.slice(0, 32) + '…', feedbackHash: ref.hash });
  const txHash = await wallet.writeContract({
    address: REPUTATION_REGISTRY,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'giveFeedback',
    args: [BigInt(w.agentId), BigInt(w.value), w.valueDecimals ?? 0, w.tag1, w.tag2 ?? '', w.endpoint, ref.uri, ref.hash],
  });
  await waitOk(txHash, 'giveFeedback');
  log.tx(`feedback ${w.tag1}${w.tag2 ? `/${w.tag2}` : ''} on agent ${w.agentId}`, txHash, { agentId: w.agentId, tag1: w.tag1, tag2: w.tag2 });
  return { txHash, ref, clientAddress, file };
}

export interface TagSummary {
  tag1: string;
  count: number;
  value: number;
}

/** getSummary per tag, over every client the registry knows. */
export async function readReputation(agentId: string, tags: string[]): Promise<{ clients: Address[]; summaries: TagSummary[] }> {
  const clients = (await publicClient.readContract({
    address: REPUTATION_REGISTRY,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'getClients',
    args: [BigInt(agentId)],
  })) as Address[];
  if (clients.length === 0) return { clients, summaries: [] };
  const summaries: TagSummary[] = [];
  for (const tag1 of tags) {
    const [count, value, decimals] = await publicClient.readContract({
      address: REPUTATION_REGISTRY,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'getSummary',
      args: [BigInt(agentId), clients, tag1, ''],
    });
    if (count > 0n) summaries.push({ tag1, count: Number(count), value: Number(value) / 10 ** Number(decimals) });
  }
  return { clients, summaries };
}

export interface FeedbackEntry {
  client: Address;
  index: number;
  value: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

/** The last `max` entries across clients, newest index first per client. */
export async function readRecentFeedback(agentId: string, max = 10): Promise<FeedbackEntry[]> {
  const clients = (await publicClient.readContract({
    address: REPUTATION_REGISTRY,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'getClients',
    args: [BigInt(agentId)],
  })) as Address[];
  const out: FeedbackEntry[] = [];
  for (const client of clients) {
    const last = Number(
      await publicClient.readContract({
        address: REPUTATION_REGISTRY,
        abi: REPUTATION_REGISTRY_ABI,
        functionName: 'getLastIndex',
        args: [BigInt(agentId), client],
      }),
    );
    for (let i = last; i >= 1 && out.length < max; i--) {
      const [value, decimals, tag1, tag2, revoked] = await publicClient.readContract({
        address: REPUTATION_REGISTRY,
        abi: REPUTATION_REGISTRY_ABI,
        functionName: 'readFeedback',
        args: [BigInt(agentId), client, BigInt(i)],
      });
      out.push({ client, index: i, value: Number(value) / 10 ** Number(decimals), tag1, tag2, revoked });
    }
    if (out.length >= max) break;
  }
  return out;
}
