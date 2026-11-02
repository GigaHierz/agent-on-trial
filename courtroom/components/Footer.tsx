import { LogoMark } from '@/components/ui/Logo';
import { BUILT_WITH, REPO_URL, SPEAKERS } from '@/lib/speakers';

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[auto_1fr_1fr]">
        <div className="flex items-start gap-3">
          <LogoMark size={32} />
          <div className="leading-tight">
            <div className="font-bold">An Agent on Trial</div>
            <div className="text-xs text-fg-3">Agentic Hub · Devcon</div>
          </div>
        </div>
        <div>
          <div className="eyebrow mb-3 text-fg-3">Speakers</div>
          <ul className="flex flex-col gap-2">
            {SPEAKERS.map((s) => (
              <li key={s.name} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-fg">{s.name}</span>
                <a href={s.x} target="_blank" rel="noopener noreferrer" className="text-mint no-underline hover:underline">
                  {s.handle}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="eyebrow mb-3 text-fg-3">Built with</div>
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {BUILT_WITH.map((b) => (
              <li key={b.name}>
                <a href={b.href} target="_blank" rel="noopener noreferrer" className="text-fg-2 no-underline hover:text-fg">
                  {b.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 pb-8 text-xs text-fg-3 sm:px-6">
        <span>Mainnet only. Nothing is simulated.</span>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="no-underline hover:text-fg-2">
          Code on GitHub
        </a>
      </div>
    </footer>
  );
}
