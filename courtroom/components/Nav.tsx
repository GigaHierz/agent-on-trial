import Link from 'next/link';
import { Suspense } from 'react';
import { NavLinks } from '@/components/NavLinks';
import { RoundSwitch } from '@/components/RoundSwitch';
import { Logo } from '@/components/ui/Logo';
import { resolveRounds } from '@/lib/view-round';

export async function Nav() {
  const { round } = await resolveRounds();
  return (
    <header className="shrink-0 border-b border-line bg-ink/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="no-underline" aria-label="An Agent on Trial, home">
          <Logo withText />
        </Link>
        <div className="flex items-center gap-4 sm:gap-6">
          <nav className="flex items-center gap-4 sm:gap-6" aria-label="Main">
            <Suspense fallback={null}>
              <NavLinks />
            </Suspense>
          </nav>
          <RoundSwitch active={round} />
        </div>
      </div>
    </header>
  );
}
