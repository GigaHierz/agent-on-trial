'use client';

import type { Evidence, Exhibit } from '@trial/shared';
import { usePoll } from '@/lib/use-poll';

const DRY = /^\[dry run\] /;

/**
 * Tonight's dispute, from the evidence board: filed, waiting for the jurors,
 * or ruled. Reads the same round the projector shows; nothing here is a claim
 * of its own, only what the D exhibits of the latest dispute say.
 */
export function DisputeLiveCard({ round }: { round: string }) {
  const { data, error } = usePoll<Evidence | null>(`/api/evidence?round=${encodeURIComponent(round)}`, 3000);
  const d = (data?.exhibits ?? []).filter((e) => e.act === 'dispute' && e.id.startsWith('D'));
  const opened = [...d].reverse().find((e) => /Dispute \d+ opened/.test(e.title));
  const id = opened?.title.match(/Dispute (\d+) opened/)?.[1];
  const mine = (e: Exhibit) => !id || String((e.detail as { disputeId?: unknown } | undefined)?.disputeId ?? id) === id;
  const ruled = d.filter((e) => mine(e) && /^(\[dry run\] )?Ruling on the /.test(e.title));
  const noFeedback = d.find((e) => mine(e) && /No feedback written/.test(e.title));
  const pending = d.find((e) => mine(e) && /Ruling pending/.test(e.title));
  const failed = !opened ? [...d].reverse().find((e) => /^(\[dry run\] )?(Dispute not opened|Dispute may exist|No dispute opened|Dispute simulated)/.test(e.title)) : undefined;
  const rehearsal = d.some((e) => DRY.test(e.title));
  const recorded = d.some((e) => e.fixture);
  const caseUrl = [opened, pending, noFeedback, ...ruled].map((e) => e?.url).find((u) => u?.startsWith('https://'));

  const step = ruled.length || noFeedback ? 3 : opened ? 2 : 0;
  const status = data === null && !error
    ? 'Loading the evidence board…'
    : error && !data
      ? 'Can’t reach the evidence board right now.'
      : ruled.length
        ? rehearsal
          ? 'Rehearsal: the stand-in jurors accepted the claim. Nothing was written on chain.'
          : 'The jurors accepted the claim. The ruling is on the agents’ ERC-8004 records.'
        : noFeedback
          ? noFeedback.title.replace(DRY, '')
          : pending
            ? 'Filed. The jurors are reading the evidence and voting.'
            : opened
              ? 'Filed.'
              : failed
                ? failed.title.replace(DRY, '')
                : 'No dispute yet tonight. It starts when the agent buys the report.';

  return (
    <section aria-live="polite" className="rounded-2xl border border-line bg-white/[0.03] p-6">
      <p className="eyebrow text-fg-3">
        {recorded ? 'Recorded dispute' : rehearsal ? 'Rehearsal' : 'Tonight’s dispute'} · round {round}
      </p>
      <p className="mt-2 text-2xl leading-snug">{opened ? `Dispute ${id} opened` : 'Waiting for the case'}</p>
      <ol className="mt-4 grid grid-cols-3 gap-2 text-sm">
        {['Filed', 'Jurors vote', 'Ruled'].map((label, i) => (
          <li key={label} className={`step rounded-md border px-3 py-2 ${step > i ? 'is-done border-mint/60 text-mint' : 'border-line text-fg-3'} ${step === i + 1 && i === 1 && !ruled.length && !noFeedback ? 'is-live' : ''}`}>
            {label}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-lg text-fg-2">{status}</p>
      {ruled.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-base text-fg-2">
          {ruled.map((e) => (
            <li key={e.id}>
              {e.id} {e.title.replace(DRY, '')}
            </li>
          ))}
        </ul>
      )}
      {caseUrl && (
        <a href={caseUrl} target="_blank" rel="noreferrer" className="mt-4 inline-block text-lg text-mint underline">
          Open the case in Kleros Court
        </a>
      )}
    </section>
  );
}
