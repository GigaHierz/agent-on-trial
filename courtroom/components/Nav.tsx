import Link from 'next/link';
import { Suspense } from 'react';
import { NavLinks } from '@/components/NavLinks';
import { RoundSwitch } from '@/components/RoundSwitch';
import { Logo } from '@/components/ui/Logo';
import { DEFAULT_ROUND } from '@/lib/keys';
import { getRedis } from '@/lib/redis';
import { currentRound } from '@/lib/store';

export async function Nav() {
  const round = getRedis() ? await currentRound().catch(() => DEFAULT_ROUND) : DEFAULT_ROUND;
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/80 backdrop-blur">
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
          <Suspense fallback={null}>
            <RoundSwitch current={round} />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
