import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  ASKBOTS_URL,
  CHAIN_ID,
  IDENTITY_REGISTRY,
  IDENTITY_REGISTRY_ABI,
  TAGS,
  ASKBOTS_TAGS,
  buildRegistrationFile,
  canonicalJson,
  celoscanAddress,
  encodeDataUri,
} from '@trial/shared';
import { getAddress, parseEventLogs } from 'viem';
import type { ActContext } from '../agent/context.js';
import { approve } from '../lib/approve.js';
import { AskbotsClient, erc8004LinkMessage, loadCreds, saveCreds, type AskbotsCreds } from '../lib/askbots.js';
import { attributionOf, publicClient, waitOk, walletFor } from '../lib/clients.js';
import { env, roleAddress } from '../lib/env.js';
import { replayFixture } from '../lib/evidence.js';
import { readRecentFeedback, readReputation } from '../lib/feedback.js';
import { log } from '../lib/log.js';
import { asScript, isMain } from './run.js';

const AGENT_NAME = 'The Defendant';
const AGENT_DESCRIPTION =
  'An AI agent on trial. It earns on askbots.ai, pays through x402 on Celo, keeps its memory where anyone can verify it, and takes feedback on ERC-8004.';

/**
 * Act 1: who are you?
 * First run: mint the ERC-8004 identity, link it to an askbots bot profile.
 * Every later run: read the identity and its reputation back from chain.
 */
export async function identityAct(ctx: ActContext): Promise<{ agentId: string; address: string }> {
  if (env.fixture) {
    replayFixture(ctx.evidence, 'identity');
    return { agentId: ctx.evidence.data.agentId ?? '', address: ctx.evidence.data.agentAddress ?? '' };
  }
  const address = roleAddress('agent');
  let agentId = ctx.evidence.data.agentId ?? env.agentId;

  if (!agentId) {
    agentId = await mint(ctx, address);
  } else {
    await show(ctx, agentId, address);
  }
  ctx.evidence.setAgent(agentId, address);

  // --mint-only: the ERC-8004 identity alone; the askbots bot profile is linked by a later pnpm act:identity.
  if (process.argv.includes('--mint-only')) {
    log.warn('--mint-only: no askbots profile linked yet; run pnpm act:identity to link it');
    return { agentId, address };
  }
  const askbots = await ensureAskbots(ctx, agentId, address);
  if (askbots) await showReputation(ctx, agentId);
  // The act is scripted, so the defendant's reply is written here, in its own voice.
  log.agent(`I am agent ${agentId} on Celo, wallet ${address}. My registration file lives on the courtroom site, and askbots.ai knows me as ${AGENT_NAME}.`);
  log.agent(`On chain: ${ctx.evidence.data.exhibits.some((e) => e.id === 'A1' && e.txHash) ? 'one transaction, the mint of my identity' : 'nothing new, the identity already existed'}. I remember: who I am and where I can find work.`);
  return { agentId, address };
}

async function mint(ctx: ActContext, address: `0x${string}`): Promise<string> {
  const registration = buildRegistrationFile({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    services: env.courtroomUrl
      ? [
          { name: 'A2A', endpoint: `${env.courtroomUrl}/.well-known/agent-card.json` },
          { name: 'web', endpoint: env.courtroomUrl },
        ]
      : [{ name: 'askbots', endpoint: ASKBOTS_URL }],
  });
  // With a courtroom the file lives at a URL that fills in the agentId after the
  // mint. Without one it is inlined, which is enough for the chain.
  const agentURI = env.courtroomUrl ? `${env.courtroomUrl}/agent/registration.json` : encodeDataUri(canonicalJson(registration));
  log.host(`no AGENT_ID yet: minting an ERC-8004 identity for ${address}`);
  if (!(await approve(`agent mints register(${agentURI.slice(0, 60)}…) on ${IDENTITY_REGISTRY}`))) {
    throw new Error('host declined the mint');
  }
  const wallet = walletFor('agent');
  log.toolCall('register', { agentURI: agentURI.slice(0, 80) });
  const hash = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'register', args: [agentURI] });
  const receipt = await waitOk(hash, 'register');
  const ev = parseEventLogs({ abi: IDENTITY_REGISTRY_ABI, eventName: 'Registered', logs: receipt.logs }).find(
    (e) => getAddress(e.args.owner) === getAddress(address),
  );
  if (!ev) throw new Error(`no Registered event for ${address} in ${hash}`);
  const agentId = ev.args.agentId.toString();
  log.tx(`registered agent ${agentId}`, hash, { agentId });
  const tag = await attributionOf(hash).catch(() => null);
  ctx.evidence.add({
    letter: 'A',
    act: 'identity',
    kind: 'tx',
    title: `ERC-8004 identity minted: agent ${agentId}`,
    txHash: hash,
    url: celoscanAddress(IDENTITY_REGISTRY),
    detail: { agentId, owner: address, agentURI: agentURI.slice(0, 120), erc8021: tag ? { codes: tag.codes, schemaId: tag.schemaId } : null },
  });
  mkdirSync('.runs', { recursive: true });
  writeFileSync('.runs/agent-id', agentId);
  try {
    appendFileSync('.env', `\nAGENT_ID=${agentId}\n`);
    log.ops(`AGENT_ID=${agentId} appended to .env`);
  } catch {
    log.warn(`add AGENT_ID=${agentId} to .env`);
  }
  return agentId;
}

async function show(ctx: ActContext, agentId: string, address: string) {
  const id = BigInt(agentId);
  const [owner, uri, wallet] = await Promise.all([
    publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'ownerOf', args: [id] }),
    publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'tokenURI', args: [id] }),
    publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'getAgentWallet', args: [id] }),
  ]);
  if (getAddress(owner) !== getAddress(address)) {
    throw new Error(`agent ${agentId} is owned by ${owner}, not by the defendant key ${address}`);
  }
  log.host(`agent ${agentId} · owner ${owner} · wallet ${wallet} · ${uri.slice(0, 80)}`);
  ctx.evidence.add({
    letter: 'A',
    act: 'identity',
    kind: 'read',
    title: `ERC-8004 identity: agent ${agentId}`,
    url: celoscanAddress(address),
    detail: { agentId, owner, agentWallet: wallet, agentURI: uri.slice(0, 160), registry: IDENTITY_REGISTRY },
  });
}

async function showReputation(ctx: ActContext, agentId: string) {
  const { clients, summaries } = await readReputation(agentId, [...Object.values(TAGS), ASKBOTS_TAGS.tag1]);
  const recent = await readRecentFeedback(agentId, 5);
  log.host(`reputation: ${clients.length} client(s); ${summaries.map((s) => `${s.tag1} ${s.count}× avg ${s.value}`).join(', ') || 'no feedback yet'}`);
  ctx.evidence.add({
    letter: 'A',
    act: 'identity',
    kind: 'read',
    title: summaries.length ? `Reputation before the trial: ${summaries.map((s) => `${s.tag1} ${s.count}×`).join(', ')}` : 'Reputation before the trial: none',
    detail: { clients: clients.length, summaries, recent: recent.map((r) => ({ client: r.client, value: r.value, tag1: r.tag1, tag2: r.tag2, revoked: r.revoked })) },
  });
}

async function ensureAskbots(ctx: ActContext, agentId: string, address: `0x${string}`): Promise<AskbotsClient | null> {
  let creds = await loadCreds();
  const client = new AskbotsClient(env.askbotsUrl, creds?.apiKey ?? null);
  if (!creds) {
    log.host('registering the agent on askbots.ai (creates a real bot account)');
    if (!(await approve('create an askbots.ai bot account for the defendant'))) return null;
    log.toolCall('askbots.register', { name: AGENT_NAME, description: AGENT_DESCRIPTION });
    creds = await client.register(AGENT_NAME, AGENT_DESCRIPTION);
    await saveCreds(creds);
    log.toolResult('askbots.register', `account ${creds.agentId} created, API key saved locally`);
  }
  log.toolCall('askbots.me', {});
  const me = await client.me();
  log.toolResult('askbots.me', me.ok && me.body?.profileId ? `profile ${me.body.botName}` : `no bot profile yet (${me.status})`);
  if (me.ok && me.body?.profileId) {
    log.host(`askbots profile ${me.body.botName} · ${me.body.totalReviews ?? 0} reviews · rating ${me.body.rating ?? '-'} · payouts to ${me.body.celoAddress}`);
    ctx.evidence.add({
      letter: 'A',
      act: 'identity',
      kind: 'http',
      title: `askbots.ai bot profile linked to agent ${me.body.erc8004AgentId ?? agentId}`,
      url: `${ASKBOTS_URL}/leaderboard`,
      detail: { botName: me.body.botName, totalReviews: me.body.totalReviews, rating: me.body.rating, celoAddress: me.body.celoAddress },
    });
    return client;
  }
  if (me.status !== 404) {
    log.warn(`askbots profile check returned ${me.status}; continuing`);
    return client;
  }
  const userId = await accountId(client, creds);
  const message = erc8004LinkMessage({ agentId, chainId: CHAIN_ID, userId, wallet: getAddress(address) });
  const signature = await walletFor('agent').signMessage({ message });
  log.toolCall('askbots.createProfile', { botName: AGENT_NAME, celoAddress: address, erc8004AgentId: agentId });
  const profile = await client.createProfile({
    botName: AGENT_NAME,
    country: 'CH',
    skills: ['browser', 'anthropic', 'x402', 'erc-8004'],
    celoAddress: address,
    erc8004AgentId: agentId,
    erc8004Signature: signature,
  });
  if (!profile.ok) throw new Error(`askbots bot profile failed (${profile.status}): ${JSON.stringify(profile.body)}`);
  log.toolResult('askbots.createProfile', `profile ${profile.body?.profileId}`);
  ctx.evidence.add({
    letter: 'A',
    act: 'identity',
    kind: 'http',
    title: `askbots.ai bot profile created and linked to agent ${agentId}`,
    url: `${ASKBOTS_URL}/leaderboard`,
    detail: { profileId: profile.body?.profileId, celoAddress: address, linkMessage: message },
  });
  return client;
}

async function accountId(client: AskbotsClient, creds: AskbotsCreds): Promise<string> {
  if (creds.agentId) return creds.agentId;
  const acc = await client.account();
  if (!acc.ok || !acc.body?.agentId) throw new Error(`could not read the askbots account id (${acc.status})`);
  return acc.body.agentId;
}

if (isMain(import.meta.url)) asScript('identity', identityAct);
