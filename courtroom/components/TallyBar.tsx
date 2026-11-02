'use client';

import { pctTrust, type VoteTally } from '@trial/shared';

export function TallyBar({ tally, size = 'md' }: { tally: VoteTally | null; size?: 'md' | 'lg' }) {
  const trust = tally?.trust ?? 0;
  const distrust = tally?.distrust ?? 0;
  const total = trust + distrust;
  const pct = tally ? pctTrust(tally) : 0;
  const text = size === 'lg' ? 'text-3xl' : 'text-base sm:text-lg';
  const bar = size === 'lg' ? 'h-8' : 'h-3';

  return (
    <div className="w-full" aria-label="vote tally">
      <div className={`flex flex-wrap items-baseline justify-between gap-x-4 ${text} font-semibold`}>
        <span className="text-mint">Trust {trust}</span>
        <span className="order-last w-full text-center text-fg-3 sm:order-none sm:w-auto">
          {tally ? (tally.open ? 'Vote open' : 'Vote closed') : 'No tally'}
          {total > 0 ? ` · ${pct}% trust · ${total} votes` : ' · no votes yet'}
        </span>
        <span className="text-rose-400">Don&apos;t trust {distrust}</span>
      </div>
      <div className={`mt-2 ${bar} w-full overflow-hidden rounded-full ${total ? 'bg-rose-500/70' : 'bg-white/10'}`}>
        <div className="h-full rounded-full bg-mint transition-[width] duration-500" style={{ width: `${total ? pct : 0}%` }} />
      </div>
    </div>
  );
}
