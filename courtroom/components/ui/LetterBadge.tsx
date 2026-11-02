/** An exhibit id ("A1", "D3", "V2") as a fixed-width mint label. */
export function LetterBadge({ id, className = '' }: { id: string; className?: string }) {
  return <span className={`inline-block w-9 shrink-0 font-bold tabular-nums text-mint ${className}`}>{id}</span>;
}
