'use client';

import type { Evidence, Exhibit, VoteTally } from '@trial/shared';
import type { AgentSummary } from '@/lib/chain';
import { COLUMN_TITLES, exhibitHref } from '@/lib/links';
import { usePoll } from '@/lib/use-poll';
import { TallyBar } from './TallyBar';

const POLL_MS = 2000;
const CHAIN_POLL_MS = 10_000;
const COLUMNS = ['A', 'B', 'C', 'D'] as const;

function groupExhibits(evidence: Evidence | null): Record<string, Exhibit[]> {
  const groups: Record<string, Exhibit[]> = { A: [], B: [], C: [], D: [] };
  for (const ex of evidence?.exhibits ?? []) {
    const letter = ex.id[0];
    // Verdict exhibits sit with identity and reputation.
    const col = letter === 'V' ? 'A' : letter;
    (groups[col] ??= []).push(ex);
  }
  return groups;
}

function Badge({ children, tone }: { children: string; tone: 'muted' | 'data' }) {
  const cls = tone === 'data' ? 'border-violet-500/60 text-violet-300' : 'border-neutral-600 text-neutral-400';
  return <span className={`rounded border px-2 py-0.5 text-sm uppercase tracking-wide ${cls}`}>{children}</span>;
}

/** Disputes whose ruling has come in: a ruling exhibit or a no-feedback note names them. */
function ruledDisputes(evidence: Evidence | null): Set<string> {
  const ids = new Set<string>();
  for (const e of evidence?.exhibits ?? []) {
    const d = e.detail as { disputeId?: unknown; pending?: unknown; noFeedback?: unknown } | undefined;
    if (d?.disputeId !== undefined && d.pending !== true && (/Ruling on the /.test(e.title) || d.noFeedback === true)) ids.add(String(d.disputeId));
  }
  return ids;
}

function ExhibitRow({ ex, gateway, ruled }: { ex: Exhibit; gateway: string; ruled: Set<string> }) {
  const link = exhibitHref(ex, gateway);
  const isData = ex.uri?.startsWith('data:') && !ex.gatewayUrl;
  const isVerdict = ex.id.startsWith('V');
  // A "Ruling pending" note stays in the record; once its ruling is on the board it reads as done, not waiting.
  const d = ex.detail as { pending?: unknown; disputeId?: unknown } | undefined;
  const resolved = d?.pending === true && ruled.has(String(d.disputeId));
  const title = resolved ? ex.title.replace(/Ruling pending|Ruling read, not fully written/, 'Ruling came in') : ex.title;
  return (
    <li className={`flex items-start gap-3 border-b border-neutral-800 py-2 ${resolved ? 'opacity-60' : ''}`}>
      <span className={`shrink-0 font-mono text-xl font-bold ${isVerdict ? 'text-amber-300' : 'text-neutral-300'}`}>
        {ex.id}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xl leading-tight">
          {isVerdict && <span className="mr-2 text-amber-300">Verdict</span>}
          {title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {link && (
            <a href={link.href} target="_blank" rel="noreferrer" className="text-base text-sky-300 underline">
              {link.label}
            </a>
          )}
          {isData && <Badge tone="data">data</Badge>}
          {ex.fixture && <Badge tone="muted">recorded</Badge>}
        </div>
      </div>
    </li>
  );
}

export function ProjectorClient({ round, gateway, qrSvg }: { round: string; gateway: string; qrSvg: string }) {
  const q = encodeURIComponent(round);
  const { data: evidence, error } = usePoll<Evidence | null>(`/api/evidence?round=${q}`, POLL_MS);
  const { data: tally } = usePoll<VoteTally>(`/api/vote/tally?round=${q}`, POLL_MS);
  const agentId = evidence?.agentId ?? null;
  const { data: chain } = usePoll<AgentSummary>(agentId ? `/api/chain/agent/${agentId}` : null, CHAIN_POLL_MS);
  const groups = groupExhibits(evidence);
  const ruled = ruledDisputes(evidence);
  const jury = chain?.summary.jury;

  return (
    <div className="grid h-screen w-screen grid-rows-[auto_1fr_auto] overflow-hidden px-10 py-6">
      <header className="flex items-baseline justify-between pb-4">
        <h1 className="text-4xl font-bold tracking-tight">The evidence</h1>
        <p className="font-mono text-xl text-neutral-400">
          round {round}
          {agentId ? ` · agent #${agentId}` : ''}
        </p>
      </header>

      <section className="grid min-h-0 grid-cols-4 gap-8">
        {COLUMNS.map((col) => (
          <div key={col} className="min-h-0 overflow-hidden">
            <h2 className="mb-2 border-b-2 border-neutral-600 pb-2 text-2xl font-semibold">
              <span className="mr-3 font-mono text-neutral-400">{col}</span>
              {COLUMN_TITLES[col]}
            </h2>
            <ul>
              {groups[col]?.map((ex) => (
                <ExhibitRow key={ex.id} ex={ex} gateway={gateway} ruled={ruled} />
              ))}
            </ul>
            {(groups[col]?.length ?? 0) === 0 && <p className="py-2 text-lg text-neutral-600">Nothing yet.</p>}
          </div>
        ))}
      </section>

      <footer className="grid grid-cols-[180px_1fr_auto] items-center gap-8 border-t border-neutral-800 pt-5">
        <div className="qr w-[180px] rounded-xl bg-neutral-900 p-3" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <div>
          <TallyBar tally={tally} size="lg" />
          {error && <p className="mt-2 text-rose-400">{error}</p>}
        </div>
        <div className="min-w-[280px] text-right">
          {jury ? (
            <>
              <p className="text-sm uppercase tracking-widest text-amber-300">Verdict on chain</p>
              <p className="text-5xl font-bold">{Math.round(jury.value)}% trust</p>
              <p className="text-neutral-400">
                {jury.count} jury {jury.count === 1 ? 'entry' : 'entries'}
              </p>
            </>
          ) : (
            <p className="text-2xl text-neutral-600">Verdict pending</p>
          )}
        </div>
      </footer>
    </div>
  );
}
