'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { VoteTally } from '@trial/shared';
import { TallyBar } from './TallyBar';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';

type Choice = 'trust' | 'distrust';

export function VoteClient() {
  const params = useSearchParams();
  const fromQuery = params.get('r');
  const [round, setRound] = useState<string | null>(fromQuery);
  const [tally, setTally] = useState<VoteTally | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fromQuery) return;
    fetch('/api/round', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ round?: string; error?: string }>)
      .then((b) => (b.round ? setRound(b.round) : setMessage(b.error ?? 'No round.')))
      .catch(() => setMessage('Could not load the round.'));
  }, [fromQuery]);

  async function vote(choice: Choice) {
    if (!round || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ round, choice }),
      });
      const body = (await res.json()) as VoteTally | { error?: string };
      if (res.ok) {
        setTally(body as VoteTally);
        setDone(true);
        setMessage('Your vote is in.');
      } else if (res.status === 409) {
        const err = (body as { error?: string }).error ?? '';
        setMessage(err.includes('closed') ? 'The vote is not open.' : 'You already voted.');
        if (err.includes('already')) setDone(true);
        const t = await fetch(`/api/vote/tally?round=${encodeURIComponent(round)}`).then((r) => r.json());
        if (t && typeof t.trust === 'number') setTally(t as VoteTally);
      } else {
        setMessage((body as { error?: string }).error ?? `Error ${res.status}`);
      }
    } catch {
      setMessage('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-57px)] max-w-md flex-col justify-center gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col items-start gap-3">
        {round && <Pill tone="mint">Round {round}</Pill>}
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">Do you trust this agent?</h1>
        <p className="text-sm text-fg-2 sm:text-base">One vote per device. The result is written on chain as ERC-8004 feedback.</p>
      </div>

      {!done && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Button variant="primary" size="xl" disabled={!round || busy} onClick={() => vote('trust')}>
            Trust
          </Button>
          <Button variant="danger" size="xl" disabled={!round || busy} onClick={() => vote('distrust')}>
            Don&apos;t trust
          </Button>
        </div>
      )}

      {message && <p className="text-xl text-fg">{message}</p>}
      {tally && <TallyBar tally={tally} />}
    </main>
  );
}
