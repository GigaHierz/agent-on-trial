import { LogoMark } from '@/components/ui/Logo';
import { BUILT_WITH, REPO_URL, SPEAKERS } from '@/lib/speakers';

/**
 * Compact footer, always at the bottom. Three blocks with the same two-row
 * shape: a small label on top, the content under it, so everything lines up.
 */
export function Footer() {
  const label = 'eyebrow text-[10px] text-fg-3';
  const row = 'mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs';
  return (
    <footer className="shrink-0 border-t border-line bg-ink/80 backdrop-blur">
      <div className="mx-auto grid max-w-6xl items-start gap-x-8 gap-y-3 px-4 py-3 sm:px-6 md:grid-cols-[auto_1fr_auto]">
        <div>
          <div className={label}>Agentic Hub · Devcon</div>
          <div className={`${row} text-fg-2`}>
            <span className="inline-flex items-center gap-2">
              <LogoMark size={14} />
              An Agent on Trial
            </span>
          </div>
        </div>
        <div>
          <div className={label}>Speakers</div>
          <div className={row}>
            {SPEAKERS.map((s) => (
              <a key={s.name} href={s.x} target="_blank" rel="noopener noreferrer" className="no-underline hover:text-fg">
                <span className="text-fg-2">{s.name.split(' ')[0]}</span> <span className="text-mint">{s.handle}</span>
              </a>
            ))}
          </div>
        </div>
        <div className="md:text-right">
          <div className={label}>Tooling</div>
          <div className={`${row} md:justify-end`}>
            {BUILT_WITH.map((b) => (
              <a key={b.name} href={b.href} target="_blank" rel="noopener noreferrer" className="text-fg-2 no-underline hover:text-fg">
                {b.name}
              </a>
            ))}
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="text-fg-2 no-underline hover:text-fg">
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
