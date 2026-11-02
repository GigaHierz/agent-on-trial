import { Acts } from '@/components/Acts';
import { RedisNotice } from '@/components/RedisNotice';
import { SpeakerCard } from '@/components/SpeakerCard';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { baseUrl } from '@/lib/env';
import { DEFAULT_ROUND } from '@/lib/keys';
import { qrSvg } from '@/lib/qr';
import { getRedis } from '@/lib/redis';
import { EVENT, SPEAKERS } from '@/lib/speakers';
import { currentRound } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const redis = getRedis();
  const round = redis ? await currentRound().catch(() => DEFAULT_ROUND) : DEFAULT_ROUND;
  const votePath = `/vote?r=${encodeURIComponent(round)}`;
  const voteUrl = `${baseUrl()}${votePath}`;
  const svg = await qrSvg(voteUrl);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-16 px-4 py-12 sm:px-6 sm:py-16">
      <section className="grid items-center gap-10 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-col items-start gap-6">
          <Pill tone="mint">
            {EVENT.date} · {EVENT.time} · {EVENT.venue}
          </Pill>
          <h1 className="text-5xl font-bold leading-[1.02] tracking-tight sm:text-7xl">An Agent on Trial</h1>
          <p className="text-2xl text-mint sm:text-3xl">Can We Trust the Machines? A Live Trial</p>
          <p className="max-w-2xl text-lg text-fg-2">
            A real agent is on trial. It mints an identity, earns, pays, gets sold junk and disputes it, all on Celo. The evidence is on
            chain. You decide.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button href={votePath} variant="primary" size="md" className="px-7 py-3 text-lg">
              Vote
            </Button>
            <Button href="/live" variant="secondary" size="md" className="px-7 py-3 text-lg">
              Watch live
            </Button>
          </div>
          {!redis && <RedisNotice />}
        </div>
        <Card className="flex w-full flex-col items-center gap-4 lg:w-[360px]">
          <div className="eyebrow self-start text-fg-3">Scan to vote</div>
          <div className="qr w-[min(70vw,300px)] rounded-xl bg-ink-2 p-4" dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="w-full break-all text-center text-xs text-fg-3">{voteUrl}</p>
        </Card>
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="eyebrow text-fg-3">The speakers</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {SPEAKERS.map((s) => (
            <SpeakerCard key={s.name} speaker={s} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="eyebrow text-fg-3">How it works</h2>
        <Acts />
      </section>
    </main>
  );
}
