/* eslint-disable @next/next/no-img-element */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function Avatar({ name, src, size = 64 }: { name: string; src?: string; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size / 2.8) };
  return (
    <span className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10 font-bold text-fg ring-2 ring-mint" style={style} aria-label={name}>
      {src ? <img src={src} alt={name} width={size} height={size} className="h-full w-full object-cover" /> : initials(name)}
    </span>
  );
}
