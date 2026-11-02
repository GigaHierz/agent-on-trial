import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';

const LINKS: { href: string; label: string; className?: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/live', label: 'Live log' },
  { href: '/projector', label: 'Evidence board', className: 'hidden md:inline-flex' },
  { href: '/vote', label: 'Vote' },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="no-underline" aria-label="An Agent on Trial, home">
          <Logo withText />
        </Link>
        <nav className="flex items-center gap-4 sm:gap-6" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={`text-sm text-fg-2 no-underline hover:text-fg ${l.className ?? 'inline-flex'}`}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
