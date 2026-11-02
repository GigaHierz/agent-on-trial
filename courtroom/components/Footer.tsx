import { LogoMark } from '@/components/ui/Logo';
import { BUILT_WITH, REPO_URL, SPEAKERS } from '@/lib/speakers';

/** One compact row, always at the bottom of the viewport: who speaks, what it's built with, where the code is. */
export function Footer() {
  return (
    <footer className="shrink-0 border-t border-line bg-ink/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-xs text-fg-3 sm:px-6">
        <span className="inline-flex items-center gap-2 text-fg-2">
          <LogoMark size={16} />
          An Agent on Trial · Agentic Hub, Devcon
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {SPEAKERS.map((s) => (
            <a key={s.name} href={s.x} target="_blank" rel="noopener noreferrer" className="no-underline hover:text-fg">
              <span className="text-fg-2">{s.name.split(' ')[0]}</span> <span className="text-mint">{s.handle}</span>
            </a>
          ))}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {BUILT_WITH.map((b) => (
            <a key={b.name} href={b.href} target="_blank" rel="noopener noreferrer" className="no-underline hover:text-fg">
              {b.name}
            </a>
          ))}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="text-fg-2 no-underline hover:text-fg">
            GitHub
          </a>
        </span>
      </div>
    </footer>
  );
}
