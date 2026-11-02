'use client';

import { useState } from 'react';
import type { Evidence, VoteTally } from '@trial/shared';
import { askStream } from '@/lib/ask-client';
import { usePoll } from '@/lib/use-poll';
import { Cited } from './Cited';
import { TallyBar } from './TallyBar';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Pill } from './ui/Pill';

type Action = 'open' | 'close' | 'reset' | 'set' | 'current';

const INPUT = 'rounded-xl border border-line bg-white/5 px-3 py-2 text-base focus:border-mint focus:outline-none';

export function BenchClient({ round: initialRound, baseUrl }: { round: string; baseUrl: string }) {
  const [round, setRound] = useState(initialRound);
  const [roundInput, setRoundInput] = useState(initialRound);
  const [trustIn, setTrustIn] = useState('');
  const [distrustIn, setDistrustIn] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [statements, setStatements] = useState<{ prosecutor: string; defense: string }>({ prosecutor: '', defense: '' });
  const [generating, setGenerating] = useState(false);

  const q = encodeURIComponent(round);
  const { data: tally, error: tallyError } = usePoll<VoteTally>(`/api/vote/tally?round=${q}`, 2000);
  const { data: evidence } = usePoll<Evidence | null>(`/api/evidence?round=${q}`, 5000);

  async function post(action: Action, extra: Record<string, unknown> = {}) {
    setStatus(null);
    const res = await fetch('/api/vote/round', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ round: action === 'current' ? roundInput : round, action, ...extra }),
    });
    const body = (await res.json()) as { error?: string };
    setStatus(res.ok ? `${action}: ok` : `${action}: ${body.error ?? res.status}`);
    if (res.ok && action === 'current') setRound(roundInput);
  }

  async function generate() {
    setGenerating(true);
    setStatus(null);
    try {
      await askStream({ round, role: 'prosecutor' }, (t) => setStatements((s) => ({ ...s, prosecutor: t })));
      await askStream({ round, role: 'defense' }, (t) => setStatements((s) => ({ ...s, defense: t })));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'generation failed');
    } finally {
      setGenerating(false);
    }
  }

  const counts = countByAct(evidence);
  const links = ['/live', '/projector', `/vote?r=${q}`, '/cross', '/agent/registration.json', '/.well-known/agent-card.json'];

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold sm:text-4xl">Bench</h1>
        <Pill tone="mint">round {round}</Pill>
      </header>

      <Card className="flex flex-col gap-3">
        <h2 className="eyebrow text-fg-3">Round</h2>
        <div className="flex flex-wrap gap-3">
          <input className={INPUT} value={roundInput} onChange={(e) => setRoundInput(e.target.value)} aria-label="Round id" />
          <Button variant="secondary" onClick={() => post('current')}>
            Set current round
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="eyebrow text-fg-3">Vote</h2>
        <TallyBar tally={tally} />
        {tallyError && <p className="text-rose-300">{tallyError}</p>}
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={() => post('open')}>
            Open vote
          </Button>
          <Button variant="secondary" onClick={() => post('close')}>
            Close vote
          </Button>
          <Button
            variant="secondary"
            className="border-rose-400/60 text-rose-300 hover:bg-rose-500/10"
            onClick={() => {
              if (window.confirm(`Reset the tally and voters for round ${round}?`)) void post('reset');
            }}
          >
            Reset vote
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input className={`${INPUT} w-28`} placeholder="trust" inputMode="numeric" value={trustIn} onChange={(e) => setTrustIn(e.target.value)} />
          <input
            className={`${INPUT} w-28`}
            placeholder="distrust"
            inputMode="numeric"
            value={distrustIn}
            onChange={(e) => setDistrustIn(e.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => {
              const extra: Record<string, number> = {};
              if (trustIn !== '') extra.trust = Number(trustIn);
              if (distrustIn !== '') extra.distrust = Number(distrustIn);
              void post('set', extra);
            }}
          >
            Set tally by hand
          </Button>
        </div>
        {status && <p className="text-sm text-fg-2">{status}</p>}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="eyebrow text-fg-3">Evidence</h2>
        {evidence ? (
          <p className="text-base">
            {evidence.exhibits.length} exhibits
            {evidence.agentId ? ` · agent #${evidence.agentId}` : ' · no agentId yet'} · run {evidence.runId}
            <br />
            <span className="text-fg-2">
              {Object.entries(counts)
                .map(([act, n]) => `${act} ${n}`)
                .join(' · ')}
            </span>
          </p>
        ) : (
          <p className="text-fg-3">No evidence posted for this round.</p>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="eyebrow text-fg-3">Closing statements</h2>
        <Button variant="primary" className="self-start" disabled={generating} onClick={() => void generate()}>
          {generating ? 'Generating…' : 'Generate prosecutor + defense'}
        </Button>
        {(['prosecutor', 'defense'] as const).map((r) => (
          <article key={r} className="rounded-xl border border-line p-4">
            <p className="eyebrow text-fg-3">{r}</p>
            <p className="mt-2 whitespace-pre-wrap text-lg leading-relaxed">
              {statements[r] ? <Cited text={statements[r]} round={round} /> : <span className="text-fg-3">—</span>}
            </p>
          </article>
        ))}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="eyebrow text-fg-3">Links</h2>
        <ul className="text-sm">
          {links.map((p) => (
            <li key={p}>
              <a className="text-mint no-underline hover:underline break-all" href={p} target="_blank" rel="noreferrer">
                {baseUrl}
                {p}
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}

function countByAct(evidence: Evidence | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ex of evidence?.exhibits ?? []) out[ex.act] = (out[ex.act] ?? 0) + 1;
  return out;
}
