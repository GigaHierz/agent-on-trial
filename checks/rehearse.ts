import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  DEMO_TOKEN,
  ERC20_ABI,
  IDENTITY_REGISTRY,
  IDENTITY_REGISTRY_ABI,
  REPUTATION_REGISTRY,
  REPUTATION_REGISTRY_ABI,
  Evidence,
  TAGS,
  hashBytes,
  decodeDataUri,
  isDataUri,
} from '@trial/shared';
import { getAddress, parseEventLogs, type Address, type Hex } from 'viem';
import { getStorage } from '../adapters/storage/index.js';
import { attributionOf, publicClient } from '../lib/clients.js';
import { env, newRunId, roleAddress } from '../lib/env.js';
import { EvidenceStore } from '../lib/evidence.js';
import { flushLog, log } from '../lib/log.js';

/**
 * pnpm rehearse [--record] [--round <id>]
 *
 * The whole show, non-interactive, on mainnet, then every artefact checked
 * against the chain. Exit 1 names the first failing exhibit. --record freezes
 * the run as evidence/fixtures.json for --fixture fallbacks.
 *
 * Before: a funded .env, an open askbots project (pnpm preflight tells you),
 * SHADY_AGENT_ID, and a courtroom if you want the vote simulated.
 */
const failures: string[] = [];
const assert = (ok: boolean, what: string) => {
  (ok ? log.info : log.error)(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

function run(script: string, extra: string[] = []) {
  log.host(`$ pnpm ${script} ${extra.join(' ')}`);
  const r = spawnSync('pnpm', [script, ...extra], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}`);
}

async function main() {
  if (env.dryRun) {
    log.error('pnpm rehearse is the live mainnet rehearsal: every act pays and signs. For a dry run use pnpm rehearse:dispute');
    await flushLog();
    process.exit(1);
  }
  const runId = newRunId();
  EvidenceStore.fresh(runId);
  log.host(`rehearsal run ${runId} · round ${env.round}`);

  run('preflight');
  const before = await summaryCounts();

  run('act:identity');
  run('act:earn');
  run('act:spend');
  run('act:dispute');
  // A Kleros ruling takes 20 to 70 minutes: wait for it here (KLEROS_REHEARSE_WAIT_MS, default 90 min).
  if (env.dispute === 'kleros') run('act:ruling', ['--wait', String(Number(process.env.KLEROS_REHEARSE_WAIT_MS ?? 5_400_000))]);
  if (env.courtroomUrl) run('vote:simulate', ['--n', '50']);
  run('act:verdict', env.courtroomUrl ? [] : ['--trust', '7', '--distrust', '3']);

  const ev = Evidence.parse(JSON.parse(readFileSync('evidence/run.json', 'utf8')));
  log.host(`checking ${ev.exhibits.length} exhibits against the chain`);
  const agentId = ev.agentId;
  assert(Boolean(agentId), 'evidence carries an agent id');
  if (!agentId) return finish(ev);
  const agent = roleAddress('agent');

  // Identity
  const owner = await publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'ownerOf', args: [BigInt(agentId)] });
  assert(getAddress(owner) === getAddress(agent), `agent ${agentId} owned by the defendant`);
  const mint = ev.exhibits.find((e) => e.act === 'identity' && e.kind === 'tx');
  if (mint?.txHash) {
    const tag = await attributionOf(mint.txHash as Hex);
    assert(Boolean(tag && tag.codes.length), `${mint.id} register tx carries an ERC-8021 tag`);
  }

  // Payout
  const payout = ev.exhibits.find((e) => e.act === 'earn' && e.kind === 'tx' && e.title.startsWith('Paid'));
  if (payout?.txHash) assert(await hasTransfer(payout.txHash as Hex, undefined, agent, 100_000n), `${payout.id} payout is a 0.10 USD₮ transfer to the agent`);
  else assert(false, 'an askbots payout exhibit exists');

  // Spend + shady settlement
  for (const act of ['spend', 'dispute'] as const) {
    const paid = ev.exhibits.find((e) => e.act === act && e.kind === 'tx' && e.title.startsWith('Paid'));
    if (paid?.txHash) assert(await hasTransfer(paid.txHash as Hex, agent), `${paid.id} ${act} settlement is a USD₮ transfer from the agent`);
    else assert(false, `a settled x402 payment exists for ${act}`);
  }

  // Feedback counts went up
  const after = await summaryCounts();
  // Only a Kleros ruling may still be pending, or not exist at all (a simulating Preset files nothing).
  // A rejected claim or a refusal writes no ruling feedback at all.
  const noFeedback = ev.exhibits.some((e) => e.act === 'dispute' && e.kind === 'note' && e.detail?.noFeedback === true);
  const rulingPending =
    !noFeedback &&
    ev.exhibits.some((e) => e.act === 'dispute' && e.kind === 'note' && e.detail?.pending === true && e.detail?.adapter === 'kleros') &&
    !ev.exhibits.some((e) => e.title.startsWith('Ruling on the defendant'));
  const simulated = ev.exhibits.some((e) => e.act === 'dispute' && e.detail?.simulated === true);
  if (rulingPending) log.warn('the Kleros ruling is still pending: the ruling count is not checked (pnpm act:ruling writes it later)');
  if (simulated) log.warn('the Kleros Preset only simulates: no dispute exists, so the ruling count is not checked');
  if (noFeedback) log.warn('the jurors did not uphold the claim: no ruling feedback is written, so the ruling count is not checked');
  for (const tag of [TAGS.earned, TAGS.paid, TAGS.ruling, TAGS.jury]) {
    if (tag === TAGS.ruling && (rulingPending || simulated || noFeedback)) continue;
    assert((after[tag] ?? 0) > (before[tag] ?? 0), `getSummary(${tag}) count grew (${before[tag] ?? 0} → ${after[tag] ?? 0})`);
  }

  // Every feedbackURI hashes to its feedbackHash
  for (const e of ev.exhibits.filter((x) => x.uri && x.hash)) {
    try {
      const bytes = isDataUri(e.uri!) ? new TextEncoder().encode(decodeDataUri(e.uri!)) : await getStorage().get(e.uri!);
      assert(hashBytes(bytes) === e.hash, `${e.id} stored bytes hash to ${e.hash!.slice(0, 12)}…`);
    } catch (err) {
      assert(false, `${e.id} fetch ${e.uri!.slice(0, 32)}…: ${(err as Error).message}`);
    }
  }
  // Feedback txs emitted NewFeedback
  for (const e of ev.exhibits.filter((x) => x.kind === 'tx' && /feedback|ruling|verdict|dispute/i.test(x.title) && x.txHash)) {
    const receipt = await publicClient.getTransactionReceipt({ hash: e.txHash as Hex });
    const logs = parseEventLogs({ abi: REPUTATION_REGISTRY_ABI, eventName: 'NewFeedback', logs: receipt.logs });
    assert(logs.length === 1, `${e.id} emitted NewFeedback`);
  }

  await finish(ev);
}

async function finish(ev: Evidence) {
  if (failures.length) {
    log.error(`${failures.length} check(s) failed; first: ${failures[0]}`);
    await flushLog();
    process.exit(1);
  }
  if (env.record) {
    const store = EvidenceStore.load();
    store.record();
  }
  log.host(`rehearsal green: ${ev.exhibits.length} exhibits`);
  await flushLog();
}

async function summaryCounts(): Promise<Record<string, number>> {
  const agentId = env.agentId ?? EvidenceStore.load().data.agentId;
  if (!agentId) return {};
  const clients = (await publicClient.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION_REGISTRY_ABI, functionName: 'getClients', args: [BigInt(agentId)] })) as Address[];
  const out: Record<string, number> = {};
  if (!clients.length) return out;
  for (const tag of Object.values(TAGS)) {
    const [count] = await publicClient.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION_REGISTRY_ABI, functionName: 'getSummary', args: [BigInt(agentId), clients, tag, ''] });
    out[tag] = Number(count);
  }
  return out;
}

async function hasTransfer(hash: Hex, from?: Address, to?: Address, exact?: bigint): Promise<boolean> {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  if (receipt.status !== 'success') return false;
  const transfers = parseEventLogs({ abi: ERC20_ABI, eventName: 'Transfer', logs: receipt.logs.filter((l) => l.address.toLowerCase() === DEMO_TOKEN.address.toLowerCase()) });
  return transfers.some(
    (t) => (!from || getAddress(t.args.from) === getAddress(from)) && (!to || getAddress(t.args.to) === getAddress(to)) && (exact === undefined || t.args.value === exact),
  );
}

main().catch(async (err) => {
  log.error(String(err));
  await flushLog();
  process.exit(1);
});
