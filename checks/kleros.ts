import { KlerosDispute, rulingMapString } from '../adapters/dispute/kleros.js';
import { confirm } from '../lib/approve.js';
import { getStorage } from '../adapters/storage/index.js';

/**
 * pnpm check:kleros [--dispute <id>]
 * pnpm check:kleros --resolve <receipt tx hash> --core <dispute id> [--local <id>]
 *
 * Read only (except --resolve): files nothing, pins nothing, submits nothing. Connects with
 * the key for KLEROS_CHAIN (KLEROS_API_KEY_TESTNET or KLEROS_API_KEY_BETA) and prints what the key's Preset is: the instructions string
 * (the service says to believe it over any document), the tools this key can
 * call, the alias slots dispute_create takes, and how this repo is configured
 * against them. With --dispute, reads that dispute live and prints its answers
 * next to KLEROS_RULING_MAP, to confirm the mapping once on the Testnet before
 * it decides anyone's reputation.
 *
 * --resolve records, in the filing record only, which dispute an unknown (may
 * have been sent) filing turned out to be, once a human has found it in the
 * Court or on Arbiscan. It reads that dispute first, refuses one in another
 * court or already held by another filing, and asks y/N. Its ruling can then be read and written (pnpm act:ruling --dispute <id>).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const line = (label: string, value: string) => console.log(`${label.padEnd(14)}${value}`);

async function main() {
  const kleros = new KlerosDispute(getStorage(), process.env, { log: { info: () => {}, warn: (t) => console.warn(`warn          ${t}`) } });
  const c = kleros.config;

  const resolve = arg('--resolve');
  if (resolve) {
    const core = arg('--core');
    if (!core || !/^\d+$/.test(core)) throw new Error('--resolve needs --core <dispute id>, the Core id the Court shows');
    const record = kleros.store.byKey(kleros.keyOf(resolve));
    if (!record) {
      const elsewhere = kleros.store.all().find((x) => x.receiptTxHash === resolve.toLowerCase() && x.service === c.service);
      throw new Error(elsewhere ? `the filing for receipt ${resolve} is on ${elsewhere.chain}: set KLEROS_CHAIN=${elsewhere.chain} and run this again` : `no filing for receipt ${resolve} via ${c.service} in ${kleros.store.path}`);
    }
    // Confirm the id before it is recorded: evidence may be submitted to it and its ruling written on Celo.
    const [row, p] = await Promise.all([kleros.service.disputeGet(core, record.chain), kleros.preset()]);
    line('dispute', `${core} on ${record.chain} · court ${row.court ?? '?'} · ${row.status} · created ${row.createdAt ?? '?'} · ${kleros.caseUrl(core, record.chain)}`);
    line('filing', `receipt ${record.receiptTxHash} · opened ${record.openedAt}${record.createTx ? ` · tx ${record.createTx}` : ''}`);
    if (p.filing && row.court && row.court !== p.filing.court) throw new Error(`dispute ${core} is in court ${row.court}, but this key files in court ${p.filing.court}: not this filing`);
    if (!(await confirm(`Is dispute ${core} the one this receipt filed (check the creation transaction on Arbiscan)? [y/N] `))) {
      console.error('not confirmed: nothing resolved');
      process.exit(1);
    }
    const f = kleros.resolveFiling(resolve, core, arg('--local'));
    line('resolved', `receipt ${f.receiptTxHash} is dispute ${f.coreDisputeID} on ${f.chain}: ${kleros.caseUrl(core, f.chain)}`);
    line('next', `pnpm act:ruling --dispute ${core}`);
    return;
  }

  const ping = await kleros.service.ping().catch((err: Error) => ({ ok: false, status: err.message }));
  line('service', `${c.url} · /health ${ping.status}`);
  if (!c.apiKey) {
    line('key', `${c.keyVar} unset. Request one per deployment at https://ai.kleros.io, Testnet (arbitrum-sepolia-testnet) first.`);
    process.exit(1);
  }

  const p = await kleros.preset();
  const create = p.tools.find((t) => t.name === 'dispute_create');
  line('key', c.keyVar);
  line('chain', `${c.chain} (KLEROS_CHAIN)${c.chain === 'arbitrum-one' ? ` · Beta, live production · KLEROS_ALLOW_BETA=${c.allowBeta ? '1' : 'unset'}` : ''}`);
  const trust = !p.chain && p.fingerprint ? (c.trustPreset === p.fingerprint ? ' · trusted (KLEROS_TRUST_PRESET matches)' : ` · once you have read them and KLEROS_CHAIN is right: KLEROS_TRUST_PRESET=${p.fingerprint}`) : '';
  if (p.filing) line('files', `court ${p.filing.court}, ${p.filing.jurors} juror${p.filing.jurors === 1 ? '' : 's'}, on ${p.filing.chain} (the instructions' filing line)`);
  line('instructions', p.instructions ? `name ${p.chain ?? 'no single chain'}${p.chain && p.chain !== c.chain ? '  ✗ MISMATCH: the key decides where disputes go' : p.chain ? '  ✓' : trust} · fingerprint ${p.fingerprint}` : `none (${p.instructionsError ?? 'initialize returned no instructions'}): nothing can be filed`);
  line('mode', `${p.mode === 'simulate' ? 'simulates (nothing is sent)' : p.mode === 'broadcast' ? 'broadcasts (every dispute_create files a real dispute)' : 'not stated plainly; read the instructions below'} · the status of the first write is the truth`);
  line('tools', p.tools.map((t) => t.name).join(', '));
  line('can file', p.canFile ? 'yes: dispute_create, evidence_pin, evidence_submit' : 'no: this key has no Preset (read tools only)');
  if (create) line('create args', JSON.stringify(create.inputSchema ?? {}));
  line('slots', p.slots.length ? p.slots.map((s) => `"${s}"`).join(', ') : 'not listed in the schema; the instructions name them');
  const slots = kleros.slotNames(p);
  const slot = (v: string | undefined, set: string | undefined, envVar: string) =>
    v ? `"${v}"${set ? ` (${envVar})` : ' (default)'}${p.slots.length && !p.slots.includes(v) ? ' ✗ not a slot of this Preset' : ''}` : `none (${envVar} unset and no default slot in the schema): this party is left out`;
  line('complainant', slot(slots.complainant, c.slots.complainant, 'KLEROS_ALIAS_COMPLAINANT'));
  line('respondent', slot(slots.respondent, c.slots.respondent, 'KLEROS_ALIAS_RESPONDENT'));
  line('rulings', `${c.rulingMap ? rulingMapString(c.rulingMap) : 'KLEROS_RULING_MAP unset: confirm the answers with --dispute <id>'} (0 and ties are refused) · wait for ${c.waitFor} · poll ${c.pollMs} ms`);
  line('court', c.courtUrl);
  line('attachment', c.pin ? 'published with evidence_pin (permanent, public)' : 'not published (KLEROS_PIN_ATTACHMENT=0)');
  const filings = kleros.store.all();
  line('state', `${c.stateFile} · ${filings.length} filing${filings.length === 1 ? '' : 's'}`);
  for (const f of filings) {
    console.log(`  ${f.status.padEnd(10)}${(f.disputeId ?? '-').padEnd(8)} ${f.chain} via ${f.service} · receipt ${f.receiptTxHash.slice(0, 10)}…${f.period ? ` · ${f.period}` : ''}${f.ruling ? ` · ruled ${f.ruling.value}${f.ruling.tied ? ' (tied)' : ''} → ${f.ruling.ruling.winner}` : ''}${f.submission ? ` · evidence ${f.submission.status}` : ''}${f.createTx ? ` · tx ${f.createTx}` : ''}`);
  }

  console.log('\ninstructions\n' + (p.instructions ?? '(none)').replace(/^/gm, '  '));

  const id = arg('--dispute');
  if (id) {
    const row = await kleros.service.disputeGet(id, c.chain);
    console.log(`\ndispute ${id} on ${c.chain} · ${kleros.caseUrl(id)}`);
    line('period', `${row.status}${row.deadline ? ` until ${row.deadline}` : ''} · round ${row.roundCount ?? '?'} · court ${row.court ?? '?'}`);
    line('ruling', `${row.ruling}${row.tied ? ' (tied: no majority)' : ''}${row.ruled ? ' · executed' : ''}${row.overridden ? ' · overridden on appeal' : ''}`);
    if (row.unresolvedFields?.length) line('unresolved', `${row.unresolvedFields.join(', ')} (${row.unresolvedReason})`);
    if (!row.rulingOptions?.length) line('answers', `none on this dispute (${row.unresolvedReason ?? 'unresolved'})`);
    for (const o of row.rulingOptions ?? []) {
      const m = Number(o.value) === 0 ? { winner: 'refused' } : c.rulingMap?.get(Number(o.value));
      const pin = m && 'title' in m && m.title && m.title.toLowerCase() !== o.title.trim().toLowerCase() ? `  ✗ the map expects "${m.title}"` : '';
      console.log(`  ${String(o.value).padStart(2)}  ${o.title.padEnd(40)} → ${m ? m.winner : '✗ NOT MAPPED'}${pin}`);
    }
    const suggested = (row.rulingOptions ?? []).filter((o) => Number(o.value) !== 0).map((o) => `${o.value}=<complainant|respondent|refused>:${o.title}`).join(',');
    if (suggested) line('map form', `KLEROS_RULING_MAP="${suggested}"`);
  }

  const h = await kleros.health();
  console.log(`\nhealth        ${h.ok ? 'ok' : 'FAIL'} ${h.detail ?? ''}`);
  if (!h.ok) process.exit(1);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
