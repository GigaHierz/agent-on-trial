'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const ROUNDS: { id: string; label: string }[] = [
  { id: 'show', label: 'Live' },
  { id: 'test', label: 'Test data' },
];

/**
 * Switches the page between the live round and the rehearsal round by
 * rewriting the round query on the current path. Nothing is stored: the
 * stage laptop follows the URL, the public default stays whatever the bench
 * set. The exhibit page names its parameter `round`, the rest use `r`.
 */
export function RoundSwitch({ current }: { current: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const key = pathname.startsWith('/exhibit') ? 'round' : 'r';
  const active = params.get(key) ?? current;

  return (
    <div className="inline-flex rounded-full border border-line bg-white/5 p-0.5 text-xs" role="group" aria-label="Round">
      {ROUNDS.map((r) => {
        const next = new URLSearchParams(params.toString());
        next.set(key, r.id);
        const on = active === r.id;
        return (
          <Link
            key={r.id}
            href={`${pathname}?${next.toString()}`}
            aria-current={on ? 'true' : undefined}
            className={`rounded-full px-3 py-1 no-underline transition-colors ${on ? 'bg-mint text-ink' : 'text-fg-2 hover:text-fg'}`}
          >
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}
