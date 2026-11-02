'use client';

import { usePathname, useRouter } from 'next/navigation';

const ROUNDS: { id: string; label: string }[] = [
  { id: 'show', label: 'Live' },
  { id: 'test', label: 'Test data' },
];

/**
 * Switches every page between the live round and the rehearsal round. The
 * choice lives in a cookie, so it follows you across the tabs; the server
 * reads it when a page has no explicit round in its URL. The vote ignores it.
 */
export function RoundSwitch({ active }: { active: string }) {
  const router = useRouter();
  const pathname = usePathname();

  const choose = (id: string) => {
    document.cookie = `viewRound=${id}; path=/; max-age=86400; samesite=lax`;
    // Drop any explicit round from the URL so the cookie decides, then re-render on the server.
    router.push(pathname);
    router.refresh();
  };

  return (
    <div className="inline-flex rounded-full border border-line bg-white/5 p-0.5 text-xs" role="group" aria-label="Round">
      {ROUNDS.map((r) => {
        const on = active === r.id;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => choose(r.id)}
            aria-pressed={on}
            className={`rounded-full px-3 py-1 transition-colors ${on ? 'bg-mint text-ink' : 'text-fg-2 hover:text-fg'}`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
