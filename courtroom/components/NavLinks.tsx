'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS: { href: string; label: string; className?: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/chat', label: 'Chat' },
  { href: '/projector', label: 'Evidence board', className: 'hidden md:inline-flex' },
  { href: '/vote', label: 'Vote' },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {LINKS.map((l) => {
        const on = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
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
