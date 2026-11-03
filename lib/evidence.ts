import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Evidence, Exhibit, Fixtures, type Evidence as EvidenceT, type Exhibit as ExhibitT } from '@trial/shared';
import { CURRENT_RUN_FILE, currentRunId, env } from './env.js';
import { log, showUri } from './log.js';
import { publish } from './publish.js';

const RUN_FILE = env.dryRun ? 'evidence/dry-run.json' : 'evidence/run.json';
const FIXTURES_FILE = 'evidence/fixtures.json';

/**
 * The evidence of one run. Exhibit ids are assigned here: letter from the act,
 * number by order. The file is rewritten on every add and mirrored to the courtroom.
 */
export class EvidenceStore {
  private constructor(public data: EvidenceT) {}

  static load(): EvidenceStore {
    const runId = currentRunId();
    try {
      const parsed = Evidence.parse(JSON.parse(readFileSync(RUN_FILE, 'utf8')));
      if (parsed.runId === runId) return new EvidenceStore(parsed);
    } catch {
      /* new run */
    }
    const fresh: EvidenceT = {
      runId,
      round: env.round,
      startedAt: new Date().toISOString(),
      agentId: env.agentId,
      shadyAgentId: env.shadyAgentId,
      exhibits: [],
    };
    const store = new EvidenceStore(fresh);
    store.save();
    return store;
  }

  /** Start over with a fresh run id. */
  static fresh(runId: string): EvidenceStore {
    writeFileSync(CURRENT_RUN_FILE, runId);
    const store = new EvidenceStore({
      runId,
      round: env.round,
      startedAt: new Date().toISOString(),
      agentId: env.agentId,
      shadyAgentId: env.shadyAgentId,
      exhibits: [],
    });
    store.save();
    return store;
  }

  get runId() {
    return this.data.runId;
  }

  /** Pick up exhibits another process added to this run since it was loaded (pnpm act:ruling next to the session). */
  reload() {
    try {
      const parsed = Evidence.parse(JSON.parse(readFileSync(RUN_FILE, 'utf8')));
      if (parsed.runId === this.data.runId && parsed.exhibits.length >= this.data.exhibits.length) this.data = parsed;
    } catch {
      /* nothing newer on disk */
    }
  }

  setAgent(agentId: string, address: string) {
    this.data.agentId = agentId;
    this.data.agentAddress = address;
    this.save();
  }

  nextId(letter: 'A' | 'B' | 'C' | 'D' | 'V'): string {
    const n = this.data.exhibits.filter((e) => e.id.startsWith(letter)).length;
    return `${letter}${n + 1}`;
  }

  add(partial: Omit<ExhibitT, 'id' | 'at'> & { letter: 'A' | 'B' | 'C' | 'D' | 'V' }): ExhibitT {
    this.reload(); // a long session must not drop what pnpm act:ruling wrote meanwhile
    const { letter, ...rest } = partial;
    // A rehearsal says so on every exhibit: nothing on the board is real.
    if (env.dryRun && !rest.title.startsWith('[dry run]')) rest.title = `[dry run] ${rest.title}`;
    const exhibit = Exhibit.parse({ ...rest, id: this.nextId(letter), at: new Date().toISOString() });
    this.data.exhibits.push(exhibit);
    this.save();
    const where = exhibit.txHash ? `tx ${exhibit.txHash}` : exhibit.uri ? showUri(exhibit.uri, exhibit.gatewayUrl) : exhibit.url ?? '';
    log.ops(`exhibit ${exhibit.id} ${exhibit.title}${where ? ` · ${where}` : ''}${exhibit.fixture ? ' · recorded' : ''}`);
    return exhibit;
  }

  find(id: string): ExhibitT | undefined {
    return this.data.exhibits.find((e) => e.id === id);
  }

  byAct(act: ExhibitT['act']): ExhibitT[] {
    return this.data.exhibits.filter((e) => e.act === act);
  }

  save() {
    mkdirSync('evidence', { recursive: true });
    writeFileSync(RUN_FILE, JSON.stringify(this.data, null, 2) + '\n');
    void publish.evidence(this.data);
  }

  /** --record: freeze this run as the fixtures file. */
  record() {
    const acts: Record<string, ExhibitT[]> = {};
    for (const e of this.data.exhibits) (acts[e.act] ??= []).push({ ...e, fixture: true });
    const fixtures = {
      recordedAt: new Date().toISOString(),
      agentId: this.data.agentId,
      agentAddress: this.data.agentAddress,
      shadyAgentId: this.data.shadyAgentId,
      acts,
    };
    writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures, null, 2) + '\n');
    log.info(`recorded ${this.data.exhibits.length} exhibits to ${FIXTURES_FILE}`);
  }
}

export function loadFixtures() {
  return Fixtures.parse(JSON.parse(readFileSync(FIXTURES_FILE, 'utf8')));
}

/** Replay the recorded exhibits of one act into the current run. */
export function replayFixture(store: EvidenceStore, act: ExhibitT['act']): ExhibitT[] {
  const fx = loadFixtures();
  const list = fx.acts[act] ?? [];
  if (!list.length) throw new Error(`no fixture recorded for act ${act}; run pnpm rehearse --record first`);
  log.warn(`--fixture: replaying ${list.length} recorded exhibit(s) for ${act}${fx.recordedAt ? ` (recorded ${fx.recordedAt.slice(0, 10)})` : ''}`);
  if (fx.agentId && fx.agentAddress && !store.data.agentId) store.setAgent(fx.agentId, fx.agentAddress);
  return list.map((e) => {
    const { id: _id, at: _at, ...rest } = e;
    return store.add({ ...rest, fixture: true, letter: e.id[0] as 'A' });
  });
}
