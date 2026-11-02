'use client';

import type { Evidence, Exhibit, VoteTally } from '@trial/shared';
import { useCallback, useEffect, useState } from 'react';
import type { AgentSummary } from '@/lib/chain';
import { COLUMN_TITLES, exhibitHref, swarmTarget } from '@/lib/links';
import { usePoll } from '@/lib/use-poll';
import { SwarmModal } from './SwarmModal';
import { TallyBar } from './TallyBar';
import { LetterBadge } from './ui/LetterBadge';
import { LogoMark } from './ui/Logo';
import { Pill } from './ui/Pill';

const POLL_MS = 2000;
const CHAIN_POLL_MS = 10_000;
const COLUMNS = ['A', 'B', 'C', 'D'] as const;
const BAND_KEY = 'projector.band';

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

function ExhibitRow({ ex, gateway, onOpenSwarm }: { ex: Exhibit; gateway: string; onOpenSwarm: (ex: Exhibit) => void }) {
  const link = exhibitHref(ex, gateway);
  const swarm = swarmTarget(ex, gateway);
  // A tx exhibit keeps its celoscan link; its evidence file on Swarm gets its own button.
  const linkIsSwarm = !!swarm && link?.href === swarm.url;
  const isData = ex.uri?.startsWith('data:') && !ex.gatewayUrl;
  const isVerdict = ex.id.startsWith('V');
  return (
    <li className="flex items-start gap-3 border-b border-line/60 py-2.5">
      <LetterBadge id={ex.id} className={`text-xl ${isVerdict ? 'text-amber-300' : ''}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xl leading-tight">
          {isVerdict && <span className="mr-2 text-amber-300">Verdict</span>}
          {ex.title}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {link && !linkIsSwarm && (
            <a href={link.href} target="_blank" rel="noreferrer" className="no-underline">
              <Pill tone="mint" className="hover:bg-mint/20">
                {link.label}
              </Pill>
            </a>
          )}
          {swarm && (
            <button type="button" onClick={() => onOpenSwarm(ex)} className="cursor-pointer">
              <Pill tone="violet" className="hover:bg-violet-400/20">
                swarm
              </Pill>
            </button>
          )}
          {isData && <Pill tone="neutral">data</Pill>}
          {ex.fixture && <Pill tone="amber">recorded</Pill>}
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
  const jury = chain?.summary.jury;
  const [viewing, setViewing] = useState<Exhibit | null>(null);
  const viewingTarget = viewing ? swarmTarget(viewing, gateway) : null;
  const closeViewer = useCallback(() => setViewing(null), []);

  // The tally band can be collapsed on a laptop; the choice sticks per device.
  const [bandOpen, setBandOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(BAND_KEY) === 'closed') setBandOpen(false);
    } catch {
      /* private mode */
    }
  }, []);
  const toggleBand = () => {
    setBandOpen((open) => {
      try {
        window.localStorage.setItem(BAND_KEY, open ? 'closed' : 'open');
      } catch {
        /* private mode */
      }
      return !open;
    });
  };

  const trust = tally?.trust ?? 0;
  const distrust = tally?.distrust ?? 0;

  return (
    <div className="grid h-screen w-screen grid-rows-[auto_1fr_auto] overflow-hidden px-10 py-6">
      <header className="flex items-center justify-between pb-4">
        <h1 className="flex items-center gap-4 text-4xl font-bold tracking-tight">
          <LogoMark size={40} />
          The evidence
        </h1>
        <Pill tone="mint" className="text-sm">
          round {round}
          {agentId ? ` · agent #${agentId}` : ''}
        </Pill>
      </header>

      <section className="grid min-h-0 grid-cols-4 gap-8">
        {COLUMNS.map((col) => (
          <div key={col} className="flex min-h-0 flex-col">
            <h2 className="mb-2 shrink-0 border-b-2 border-line pb-2 text-2xl font-semibold">
              <span className="mr-3 text-mint">{col}</span>
              {COLUMN_TITLES[col]}
            </h2>
            <ul className="min-h-0 flex-1 overflow-y-auto pr-2">
              {groups[col]?.map((ex) => (
                <ExhibitRow key={ex.id} ex={ex} gateway={gateway} onOpenSwarm={setViewing} />
              ))}
            </ul>
            {(groups[col]?.length ?? 0) === 0 && <p className="py-2 text-lg text-fg-3">Nothing yet.</p>}
          </div>
        ))}
      </section>

      <footer className="relative border-t border-line">
        <button
          type="button"
          onClick={toggleBand}
          aria-label={bandOpen ? 'Hide tally' : 'Show tally'}
          aria-expanded={bandOpen}
          className="absolute -top-3.5 right-0 rounded-full border border-line bg-ink px-3 py-0.5 text-xs text-fg-3 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-mint"
        >
          {bandOpen ? '▾ hide' : '▴ show'}
        </button>
        {bandOpen ? (
          <div className="grid grid-cols-[180px_1fr_auto] items-center gap-8 pt-5">
            <div className="qr w-[180px] rounded-xl bg-ink-2 p-3" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <div>
              <TallyBar tally={tally} size="lg" />
              {error && <p className="mt-2 text-rose-300">{error}</p>}
            </div>
            <div className="min-w-[280px] text-right">
              {jury ? (
                <>
                  <p className="eyebrow text-amber-300">Verdict on chain</p>
                  <p className="text-5xl font-bold">{Math.round(jury.value)}% trust</p>
                  <p className="text-fg-3">
                    {jury.count} jury {jury.count === 1 ? 'entry' : 'entries'}
                  </p>
                </>
              ) : (
                <p className="text-2xl text-fg-3">Verdict pending</p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-10 items-center gap-6 text-base">
            <span className="text-mint">Trust {trust}</span>
            <span className="text-rose-400">Don&apos;t trust {distrust}</span>
            <span className="text-fg-3">{jury ? `Verdict on chain · ${Math.round(jury.value)}% trust` : 'Verdict pending'}</span>
          </div>
        )}
      </footer>

      {viewing && viewingTarget && <SwarmModal exhibit={viewing} target={viewingTarget} onClose={closeViewer} />}
    </div>
  );
}
