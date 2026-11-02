/** The Agentic Hub mark: three white nodes, a mint centre, grey edges. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <g stroke="#6b7a72" strokeWidth="4" strokeLinecap="round" fill="none">
        <path d="M32 12 L12 48 L52 48 Z" />
        <path d="M32 12 L32 35 M12 48 L32 35 M52 48 L32 35" />
      </g>
      <circle cx="32" cy="12" r="6" fill="#fff" />
      <circle cx="12" cy="48" r="6" fill="#fff" />
      <circle cx="52" cy="48" r="6" fill="#fff" />
      <circle cx="32" cy="35" r="5" fill="#a8e6c3" />
    </svg>
  );
}

export function Logo({ size = 28, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="inline-flex items-center gap-3">
      <LogoMark size={size} />
      {withText && (
        <span className="hidden flex-col leading-tight sm:flex">
          <span className="text-base font-bold tracking-tight">Agentic Hub</span>
          <span className="eyebrow text-[10px] text-fg-3">An Agent on Trial</span>
        </span>
      )}
    </span>
  );
}
