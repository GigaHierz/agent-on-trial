import { LogoMark } from '@/components/ui/Logo';
import { BUILT_WITH, REPO_URL, SPEAKERS } from '@/lib/speakers';

/** Compact footer, always at the bottom: the brand, one speakers block, one tooling block. */
export function Footer() {
  return (
    <footer className="shrink-0 border-t border-line bg-ink/80 backdrop-blur">
      <div className="mx-auto grid max-w-6xl gap-x-8 gap-y-3 px-4 py-3 text-xs sm:px-6 md:grid-cols-[auto_1fr_1fr]">
        <div className="inline-flex items-center gap-2 text-fg-2">
          <LogoMark size={16} />
          <span>An Agent on Trial · Agentic Hub, Devcon</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="eyebrow text-[10px] text-fg-3">Speakers</span>
          {SPEAKERS.map((s) => (
            <a key={s.name} href={s.x} target="_blank" rel="noopener noreferrer" className="no-underline hover:text-fg">
              <span className="text-fg-2">{s.name.split(' ')[0]}</span> <span className="text-mint">{s.handle}</span>
            </a>
          ))}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 md:justify-end">
          <span className="eyebrow text-[10px] text-fg-3">Tooling</span>
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
    </footer>
  );
}
