/* eslint-disable @next/next/no-img-element */
import { initials } from '@/components/ui/Avatar';
import { Pill } from '@/components/ui/Pill';
import type { Speaker } from '@/lib/speakers';

/**
 * A speaker as a photo card: the portrait fills the card and a tag at the
 * bottom carries the name, the X handle and "Role at Company".
 */
export function SpeakerCard({ speaker }: { speaker: Speaker }) {
  return (
    <a
      href={speaker.x}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block aspect-[4/5] overflow-hidden rounded-2xl border border-line bg-ink-2 no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
    >
      {speaker.photo ? (
        <img
          src={speaker.photo}
          alt=""
          className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-6xl font-bold text-fg-3">{initials(speaker.name)}</div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink via-ink/85 to-transparent px-5 pt-16 pb-5">
        <div className="text-xl font-bold leading-tight text-fg">{speaker.name}</div>
        <div className="mt-1 text-sm text-mint">{speaker.handle}</div>
        <Pill tone="neutral" className="mt-3 normal-case tracking-normal">
          {speaker.role} at {speaker.company}
        </Pill>
      </div>
    </a>
  );
}
