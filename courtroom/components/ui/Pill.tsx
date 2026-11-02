import type { ReactNode } from 'react';

export type PillTone = 'mint' | 'neutral' | 'rose' | 'amber' | 'violet';

const TONES: Record<PillTone, string> = {
  mint: 'border-mint/60 bg-mint/10 text-mint',
  neutral: 'border-line bg-white/5 text-fg-2',
  rose: 'border-rose-400/60 bg-rose-500/10 text-rose-300',
  amber: 'border-amber-300/60 bg-amber-400/10 text-amber-200',
  violet: 'border-violet-300/60 bg-violet-400/10 text-violet-200',
};

export function Pill({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: PillTone; className?: string }) {
  return <span className={`eyebrow inline-flex items-center gap-2 rounded-full border px-3 py-1 ${TONES[tone]} ${className}`}>{children}</span>;
}
