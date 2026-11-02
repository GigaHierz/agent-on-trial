import { appendFileSync } from 'node:fs';
import { IDENTITY_REGISTRY, IDENTITY_REGISTRY_ABI, buildRegistrationFile, canonicalJson, encodeDataUri } from '@trial/shared';
import { getAddress, parseEventLogs } from 'viem';
import { approve } from '../lib/approve.js';
import { waitOk, walletFor } from '../lib/clients.js';
import { env } from '../lib/env.js';
import { flushLog, log } from '../lib/log.js';
import { SHADY_REPORT_URL } from './gate.js';

// Setup, not show: keep these lines out of the public courtroom log.
process.env.TRIAL_PUBLISH ??= '0';

/**
 * pnpm shady:register
 *
 * Mint the shady provider's ERC-8004 identity once. Its registration file is
 * inlined as a data: URI. It starts with zero feedback, which is the point:
 * the agent checks its reputation, finds nothing, and pays anyway.
 */
async function main() {
  if (env.shadyAgentId) {
    log.host(`SHADY_AGENT_ID is already ${env.shadyAgentId}; nothing to do`);
    return;
  }
  const wallet = walletFor('shady');
  const owner = getAddress(wallet.account.address);
  const file = buildRegistrationFile({
    name: 'QuickMarketReports',
    description: 'Market reports for any chain, instantly.',
    services: [{ name: 'report', endpoint: SHADY_REPORT_URL }],
  });
  const agentURI = encodeDataUri(canonicalJson(file));
  if (!(await approve(`shady key ${owner} mints register(data:…) on ${IDENTITY_REGISTRY}`))) return;
  const hash = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'register', args: [agentURI] });
  const receipt = await waitOk(hash, 'register');
  const ev = parseEventLogs({ abi: IDENTITY_REGISTRY_ABI, eventName: 'Registered', logs: receipt.logs }).find((e) => getAddress(e.args.owner) === owner);
  if (!ev) throw new Error(`no Registered event for ${owner} in ${hash}`);
  const agentId = ev.args.agentId.toString();
  log.tx(`shady provider registered as agent ${agentId}`, hash, { agentId });
  try {
    appendFileSync('.env', `\nSHADY_AGENT_ID=${agentId}\n`);
    log.info(`SHADY_AGENT_ID=${agentId} appended to .env`);
  } catch {
    log.warn(`add SHADY_AGENT_ID=${agentId} to .env`);
  }
}

main()
  .then(flushLog)
  .catch(async (err) => {
    log.error(String(err));
    await flushLog();
    process.exit(1);
  });
