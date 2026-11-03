import { ASKBOTS_URL, DEMO_TOKEN, ERC20_ABI, FACILITATOR_URL, IDENTITY_REGISTRY, IDENTITY_REGISTRY_ABI, formatUnits6 } from '@trial/shared';
import { formatEther, getAddress } from 'viem';
import { claude } from '../agent/loop.js';
import { getDispute } from '../adapters/dispute/index.js';
import { getStorage } from '../adapters/storage/index.js';
import { AskbotsClient, loadCreds } from '../lib/askbots.js';
import { ensureBuyAccount } from '../lib/buy.js';
import { builderCode, publicClient } from '../lib/clients.js';
import { env, hasRole, roleAddress, type Role } from '../lib/env.js';
import { flushLog, log, setMirror } from '../lib/log.js';
import { publish } from '../lib/publish.js';

// Setup, not show: keep these lines out of the public courtroom log.
process.env.TRIAL_PUBLISH ??= '0';

/**
 * pnpm preflight
 *
 * Everything the show depends on, checked in one pass. Hard failures exit 1.
 * Soft ones print a warning with the command that fixes them.
 */
interface Check {
  name: string;
  ok: boolean;
  hard: boolean;
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string, hard = true) => {
  checks.push({ name, ok, hard, detail });
  (ok ? log.info : hard ? log.error : log.warn)(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
};

async function balances(role: Role) {
  const address = roleAddress(role);
  const [celo, usdt] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: DEMO_TOKEN.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
  ]);
  return { address, celo: Number(formatEther(celo)), usdt: Number(formatUnits6(usdt)) };
}

async function main() {
  setMirror(false); // setup state and balances are for the operator, not the courtroom
  log.host(`preflight · round ${env.round} · storage ${env.storage} · dispute ${env.dispute} · model ${env.anthropicModel}`);

  // Keys and balances
  for (const role of ['agent', 'counterparty'] as Role[]) {
    if (!hasRole(role)) {
      add(`key ${role}`, false, `missing (see .env.example)`);
      continue;
    }
    const b = await balances(role);
    const need = role === 'agent' ? { celo: 0.05, usdt: 0.1 } : { celo: 0.2, usdt: 0.3 };
    add(`${role} ${b.address}`, b.celo >= need.celo && b.usdt >= need.usdt, `${b.celo.toFixed(3)} CELO, ${b.usdt.toFixed(2)} USD₮ (need ≥ ${need.celo} CELO, ≥ ${need.usdt} USD₮)`);
  }
  if (hasRole('agent') && hasRole('counterparty')) {
    add('keys differ', getAddress(roleAddress('agent')) !== getAddress(roleAddress('counterparty')), 'the counterparty must not own the agent (self-feedback is refused)');
    // A writer role on a wallet of its own pays its own gas: the arbitrator signs the two ruling halves in act 4.
    const shared = [roleAddress('agent'), roleAddress('counterparty')].map((a) => getAddress(a));
    for (const role of ['witness', 'arbitrator', 'jury'] as Role[]) {
      if (shared.includes(getAddress(roleAddress(role)))) continue;
      const b = await balances(role);
      add(`${role} ${b.address}`, b.celo >= 0.05, `${b.celo.toFixed(3)} CELO (need ≥ 0.05 for its feedback transactions)`);
    }
    add(
      'shady key differs from the arbitrator',
      getAddress(roleAddress('shady')) !== getAddress(roleAddress('arbitrator')),
      'set SHADY_PRIVATE_KEY: the arbitrator cannot write a ruling on a provider it owns (self-feedback is refused)',
    );
  }
  add('builder code', true, builderCode(), false);

  // Identity
  if (env.agentId) {
    try {
      const owner = await publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'ownerOf', args: [BigInt(env.agentId)] });
      add(`agent ${env.agentId}`, getAddress(owner) === getAddress(roleAddress('agent')), `owner ${owner}`);
      // Those who write on the agent must not own it: the registry refuses self-feedback.
      const clash = (['witness', 'arbitrator', 'jury'] as Role[]).filter((r) => hasRole(r) && getAddress(roleAddress(r)) === getAddress(owner));
      if (clash.length) add(`${clash.join(', ')} key`, false, `owns agent ${env.agentId}: its feedback on the agent would revert (self-feedback); give it a key of its own`);
    } catch (err) {
      add(`agent ${env.agentId}`, false, `cannot read: ${(err as Error).message.split('\n')[0]}`);
    }
  } else {
    add('agent id', true, 'AGENT_ID unset: act identity will mint one', false);
  }
  add('shady agent id', Boolean(env.shadyAgentId), env.shadyAgentId ?? 'SHADY_AGENT_ID unset: run pnpm shady:register', false);
  if (env.shadyAgentId) {
    // The registry refuses feedback from an agent's owner: the arbitrator writes the ruling on the provider, and with two
    // keys the arbitrator and the shady identity are the same counterparty key. The buyer must not own the provider it disputes.
    try {
      const owner = await publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'ownerOf', args: [BigInt(env.shadyAgentId)] });
      const clash = (['arbitrator', 'agent'] as Role[]).filter((r) => hasRole(r) && getAddress(roleAddress(r)) === getAddress(owner));
      add(
        `shady agent ${env.shadyAgentId}`,
        !clash.length,
        clash.length
          ? `owner ${owner} is also the ${clash.join(' and ')} key: ${clash.includes('arbitrator') ? 'the ruling on the provider would revert (self-feedback)' : 'the buyer would dispute itself'}; ${
              clash.includes('agent') ? 'register the shady identity from another key (SHADY_PRIVATE_KEY, clear SHADY_AGENT_ID, pnpm shady:register)' : 'give the shady provider a wallet of its own (SHADY_PRIVATE_KEY, clear SHADY_AGENT_ID, pnpm shady:register), or set ARBITRATOR_PRIVATE_KEY to a third funded wallet'
            }`
          : `owner ${owner}`,
      );
    } catch (err) {
      add(`shady agent ${env.shadyAgentId}`, false, `cannot read: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  // Services
  await probe('facilitator', `${FACILITATOR_URL}/health`);
  await probe('askbots', `${ASKBOTS_URL}/api/chain`);
  add('facilitator api key', true, env.facilitatorApiKey ? 'set: the Celo facilitator settles the shady sales' : 'BUY_FACILITATOR_API_KEY unset: the shady provider settles its own sales and pays their gas (buy gate sponsor mode)', false);
  if (env.courtroomUrl) {
    await probe('courtroom', `${env.courtroomUrl}/api/round`);
    add('courtroom host secret', Boolean(env.hostSecret), env.hostSecret ? 'set' : 'HOST_SECRET unset: the live log will not be mirrored', false);
  } else {
    add('courtroom', true, 'COURTROOM_URL unset: terminal only', false);
  }

  // Adapters
  const s = await getStorage().health();
  add(`storage ${getStorage().name}`, s.ok, s.detail ?? '');
  const d = await getDispute().health();
  add(`dispute ${getDispute().name}`, d.ok, d.detail ?? '', getDispute().name === 'kleros');

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const m = await claude().models.retrieve(env.anthropicModel);
      add('anthropic', true, `${m.id} (${m.display_name})`);
    } catch (err) {
      add('anthropic', false, (err as Error).message.split('\n')[0]);
    }
  } else {
    add('anthropic', env.scriptedAgent, env.scriptedAgent ? 'ANTHROPIC_API_KEY unset: act dispute runs with --scripted-agent (no model)' : 'ANTHROPIC_API_KEY unset', !env.scriptedAgent);
  }

  // buy
  try {
    const b = await ensureBuyAccount();
    add('buy account', true, `defendant ${b.created ? 'imported' : 'ready'} ${b.address ?? ''}`);
  } catch (err) {
    add('buy account', false, (err as Error).message.split('\n')[0]);
  }

  // askbots
  const creds = await loadCreds();
  if (!creds) {
    add('askbots creds', true, `none at ${env.askbotsCreds}: act identity registers the agent`, false);
  } else {
    const client = new AskbotsClient(env.askbotsUrl, creds.apiKey);
    const me = await client.me();
    add('askbots profile', me.ok, me.ok ? `${me.body?.botName} · ${me.body?.totalReviews ?? 0} reviews` : `${me.status}: run act identity`, false);
    if (me.ok) {
      const open = await client.listProjects().catch(() => []);
      add(
        'askbots open project',
        open.length > 0,
        open.length ? `${open.length}: "${open[0].name}" ${open[0].propertyUrl}` : 'none. Fund one from the counterparty account: pnpm exec askbots submit --file evidence/submission.json --execute',
        false,
      );
      const hist = await client.history();
      const total = hist.body?.summary.totalResponses ?? 0;
      add(
        'askbots feedback cron',
        true,
        total >= 10 ? `${total} reviews on record: run pnpm askbots:cron before the show so askbots' own tags are on chain` : `${total} reviews on record (askbots writes its tags from 10)`,
        false,
      );
    }
  }

  const hardFails = checks.filter((c) => !c.ok && c.hard);
  const softFails = checks.filter((c) => !c.ok && !c.hard);
  log.host(`${checks.length - hardFails.length - softFails.length} ok · ${softFails.length} warning(s) · ${hardFails.length} blocker(s)`);
  await flushLog();
  process.exit(hardFails.length ? 1 : 0);
}

async function probe(name: string, url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    add(name, res.ok, `${url} ${res.status}`);
  } catch (err) {
    add(name, false, `${url}: ${(err as Error).message}`);
  }
}

void publish;
main().catch(async (err) => {
  log.error(String(err));
  await flushLog();
  process.exit(1);
});
