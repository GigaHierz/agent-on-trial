import { CAIP2, DEMO_TOKEN, canonicalJson, hashBytes } from '@trial/shared';
import { z } from 'zod';
import { getDispute } from '../adapters/dispute/index.js';
import { KlerosDispute, isStalePreparing } from '../adapters/dispute/kleros.js';
import { getStorage } from '../adapters/storage/index.js';
import { env, hasRole, roleAddress } from '../lib/env.js';
import { confirm } from '../lib/approve.js';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/**
 * pnpm check:dispute [--wait <ms>]                         (DISPUTE=local)
 * DISPUTE=kleros pnpm check:dispute --file [--beta] [--wait <ms>]
 * DISPUTE=kleros pnpm check:dispute --id <disputeId> [--wait <ms>]
 *
 * Opens a dispute from a fixture receipt and prints the ruling, or "pending"
 * with the external id. A Kleros one is a real, public and permanent case: it
 * says first that it is a test over no purchase, names only parties that are
 * ours (the agent and the shady provider, when their keys are set; otherwise
 * none), and no feedback is ever written from its ruling. Shape is checked with zod so a partner adapter that
 * returns the wrong thing fails here, not on stage.
 *
 * --id skips the filing and polls a dispute opened earlier (kleros only: the
 * local arbitrator keeps its disputes in memory). With DISPUTE=kleros a filing is a real dispute with a real fee, so it takes --file, and --beta as
 * well on arbitrum-one; it is refused while an earlier filing is unresolved.
 * Come back to a pending one with --id.
 */
const OpenResult = z.object({
  disputeId: z.string().min(1),
  uri: z.string().min(1),
  gatewayUrl: z.string().optional(),
  url: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
const RulingShape = z.object({
  winner: z.enum(['complainant', 'respondent', 'refused']),
  rationale: z.string().min(1),
  ruledAt: z.string(),
  ref: z.object({ uri: z.string(), hash: z.string() }).partial().optional(),
  externalId: z.string().optional(),
  proofUrl: z.string().optional(),
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A Kleros filing pays a fee: refuse unless asked for in so many words, and never next to an unresolved one. */
async function mayFile(kleros: KlerosDispute): Promise<boolean> {
  const c = kleros.config;
  if (!process.argv.includes('--file')) {
    console.error(`DISPUTE=kleros files a real dispute on ${c.chain} and pays its fee. Add --file to do it, or --id <dispute id> to read one.`);
    return false;
  }
  const stuck = kleros.store
    .all()
    .filter((f) => f.service === c.service && f.chain === c.chain && ['preparing', 'filing', 'unknown', 'reverted'].includes(f.status) && !isStalePreparing(f, Date.now()));
  if (stuck.length) {
    console.error(`not filing: ${stuck.length} earlier filing(s) on ${c.chain} are unresolved (${stuck.map((f) => `${f.status} ${f.createTx ?? f.receiptTxHash}`).join(', ')}). Resolve them and remove them from ${kleros.store.path} first.`);
    return false;
  }
  if (c.chain === 'arbitrum-one') {
    if (!process.argv.includes('--beta')) {
      console.error('KLEROS_CHAIN=arbitrum-one is live production: real jurors, real fees. Add --beta to file a test dispute there.');
      return false;
    }
    if (!(await confirm('File a real dispute on Kleros Beta (arbitrum-one) and pay its fee? [y/N] '))) {
      console.error('not confirmed (a terminal must answer y): nothing filed');
      return false;
    }
  }
  return true;
}

async function main() {
  const waitMs = Number(arg('--wait') ?? 10_000);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`--wait ${arg('--wait')} is not a number of milliseconds`);
  const resume = arg('--id');
  const storage = getStorage();
  const dispute = getDispute();
  console.log(`adapter       ${dispute.name} (storage ${storage.name})`);
  const health = await dispute.health();
  console.log(`health        ${health.ok ? 'ok' : 'warn'} ${health.detail ?? ''}`);

  // A wait ends in reading the ruling, which needs the map: say so now, not after an hour of polling.
  if (dispute instanceof KlerosDispute && waitMs > 0 && !dispute.config.rulingMap) {
    console.error('KLEROS_RULING_MAP is unset, so no Kleros ruling can be read: set it first (pnpm check:kleros --dispute <id> prints the line), or file with --wait 0');
    process.exit(1);
  }

  let disputeId = resume;
  if (!disputeId && dispute instanceof KlerosDispute && !(await mayFile(dispute))) process.exit(1);
  if (!disputeId) {
    const delivered = await storage.put('{"report":"Celo market outlook: strong fundamentals. Confidence: high."}', { contentType: 'application/json', name: 'delivered.json' });
    // A fixture receipt. The kleros adapter files once per receipt, so each run gets its own.
    const txHash = dispute.name === 'kleros' ? hashBytes(`check:dispute ${new Date().toISOString()}`) : (('0x' + 'ab'.repeat(32)) as `0x${string}`);
    const receiptRef = await storage.put(canonicalJson({ url: 'http://localhost:4402/report/celo', amount: '0.01', asset: DEMO_TOKEN.symbol, txHash }), { name: 'receipt.json' });

    const kleros = dispute.name === 'kleros';
    // Kleros: our own addresses or none (an unknown party is left out). Local: the in-memory arbitrator's fixture.
    const payTo = env.shadyPayTo ?? (hasRole('shady') ? roleAddress('shady') : undefined);
    const parties = kleros
      ? {
          complainant: { address: hasRole('agent') ? roleAddress('agent') : ZERO, agentId: env.agentId ?? '0' },
          respondent: { address: payTo ?? ZERO, agentId: payTo ? env.shadyAgentId : undefined, endpoint: 'http://localhost:4402/report/celo' },
        }
      : {
          complainant: { address: '0x0000000000000000000000000000000000000001' as const, agentId: '1' },
          respondent: { address: '0x0000000000000000000000000000000000000002' as const, agentId: '2', endpoint: 'http://localhost:4402/report/celo' },
        };
    if (kleros) console.log(`parties       buyer ${parties.complainant.address === ZERO ? 'left out (no agent key)' : parties.complainant.address} · provider ${parties.respondent.address === ZERO ? 'left out (no shady key or SHADY_PAY_TO)' : parties.respondent.address}`);
    const opened = OpenResult.parse(
      await dispute.open({
        ...parties,
        receipt: { txHash, amount: '0.01', symbol: DEMO_TOKEN.display, amountAtomic: '10000', asset: DEMO_TOKEN.address, network: CAIP2, receiptRef },
        expected: 'a Celo market report with sections: price, volume, sources',
        delivered,
        claim: 'I paid 0.01 USD₮ for a report with price, volume and sources. The body has none of them.',
        test: kleros
          ? 'pnpm check:dispute filed this to test the Kleros wiring of Agent on Trial (an x402 demo on Celo). No purchase took place, the settlement hash is a placeholder, and no reputation feedback is written from this ruling. The text below is the demo\'s scripted claim.'
          : undefined,
      }),
    );
    console.log(`open          ${opened.disputeId} · evidence ${opened.uri.slice(0, 48)}…${opened.url ? ` · ${opened.url}` : ''}`);
    if (opened.detail) console.log(`detail        ${JSON.stringify(opened.detail)}`);
    disputeId = opened.disputeId;
  }
  console.log(`status        ${await dispute.status(disputeId)}`);

  const ruling = await dispute.ruling(disputeId, { waitMs });
  if (!ruling) {
    console.log(`ruling        pending${health.detail ? ` (${health.detail})` : ''}`);
    if (dispute.name === 'kleros' && !disputeId.startsWith('simulated-')) console.log(`resume        DISPUTE=kleros pnpm check:dispute --id ${disputeId} --wait 5400000`);
    return;
  }
  const r = RulingShape.parse(ruling);
  console.log(`ruling        ${r.winner} — ${r.rationale}`);
  if (r.ref?.uri) console.log(`ruling file   ${r.ref.uri.slice(0, 48)}…`);
  if (r.proofUrl) console.log(`proof         ${r.proofUrl}`);
  // Real jurors decide for themselves; only the local arbitrator is held to the obvious answer.
  if (dispute.name === 'local' && r.winner !== 'complainant') {
    console.error('expected the complainant to win: the delivered body has none of the required sections');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
