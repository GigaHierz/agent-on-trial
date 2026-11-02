'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const LINKS: { href: string; label: string; className?: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/chat', label: 'Chat' },
  { href: '/live', label: 'Live log', className: 'hidden sm:inline-flex' },
  { href: '/projector', label: 'Evidence board', className: 'hidden md:inline-flex' },
  { href: '/vote', label: 'Vote' },
];

/** The main links. They carry the chosen round along so a switch to test data sticks while you browse. */
export function NavLinks() {
  const pathname = usePathname();
  const params = useSearchParams();
  const round = params.get('r') ?? params.get('round');
  return (
    <>
      {LINKS.map((l) => {
        // The vote is always the live round: it never carries the switch.
        const href = round && l.href !== '/vote' ? `${l.href}?r=${encodeURIComponent(round)}` : l.href;
        const on = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={href}
            aria-current={on ? 'page' : undefined}
            className={`text-sm no-underline hover:text-fg ${on ? 'text-mint' : 'text-fg-2'} ${l.className ?? 'inline-flex'}`}
          >
            {l.label}
          </Link>
        );
      })}
    </>
  );
}
