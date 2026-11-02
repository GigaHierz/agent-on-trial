import { Avatar } from '@/components/ui/Avatar';
import { Card } from '@/components/ui/Card';
import type { Speaker } from '@/lib/speakers';

export function SpeakerCard({ speaker }: { speaker: Speaker }) {
  return (
    <Card className="flex items-center gap-4 sm:flex-col sm:items-start">
      <Avatar name={speaker.name} src={speaker.photo} size={72} />
      <div className="min-w-0">
        <div className="font-bold leading-tight">{speaker.name}</div>
        <div className="mt-1 text-sm text-fg-2">
          {speaker.role} · {speaker.company}
        </div>
        <a href={speaker.x} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm text-mint no-underline hover:underline">
          {speaker.handle}
        </a>
      </div>
    </Card>
  );
}
