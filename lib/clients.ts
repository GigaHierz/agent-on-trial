import { codeFromHostname, verifyTx, withAttribution } from '@celo/attribution-tags';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { env, isDryRun, roleKey, type Role } from './env.js';

/**
 * viem clients for Celo mainnet. Every wallet client is extended with the
 * ERC-8021 attribution tag, so each tx we sign carries the builder code.
 * The facilitator's settlements and askbots' payouts are signed by them and
 * carry no tag; the board says so.
 */
export const publicClient = createPublicClient({ chain: celo, transport: http(env.rpcUrl) });

export function builderCode(): string {
  if (env.builderCode) return env.builderCode;
  const host = env.courtroomUrl ? new URL(env.courtroomUrl).hostname : 'agent-on-trial.local';
  return codeFromHostname(host);
}

const wallets = new Map<Role, ReturnType<typeof makeWallet>>();

function makeWallet(key: Hex) {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: celo,
    transport: http(env.rpcUrl),
  }).extend(withAttribution(builderCode()));
}

export function walletFor(role: Role) {
  // The one way to sign on Celo: closed in a dry run, whatever act or tool asks.
  if (isDryRun()) throw new Error(`dry run: no wallet signs on Celo (${role} was asked to)`);
  let w = wallets.get(role);
  if (!w) {
    w = makeWallet(roleKey(role));
    wallets.set(role, w);
  }
  return w;
}

export type Wallet = ReturnType<typeof walletFor>;

/** Wait for a tx and insist it succeeded. */
export async function waitOk(hash: Hex, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return receipt;
}

/** Decode the ERC-8021 tag on one of our txs; null when untagged. */
export async function attributionOf(hash: Hex) {
  return verifyTx({ client: publicClient, hash });
}
