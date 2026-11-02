import Link from 'next/link';
import { RedisNotice } from '@/components/RedisNotice';
import { baseUrl } from '@/lib/env';
import { DEFAULT_ROUND } from '@/lib/keys';
import { qrSvg } from '@/lib/qr';
import { getRedis } from '@/lib/redis';
import { currentRound } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const redis = getRedis();
  const round = redis ? await currentRound().catch(() => DEFAULT_ROUND) : DEFAULT_ROUND;
  const voteUrl = `${baseUrl()}/vote?r=${encodeURIComponent(round)}`;
  const svg = await qrSvg(voteUrl);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-10 px-6 py-12 text-center">
      <h1 className="text-5xl font-bold tracking-tight sm:text-7xl">Can We Trust the Machines?</h1>
      <p className="max-w-3xl text-2xl text-neutral-300 sm:text-3xl">
        A real agent is on trial. It mints an identity, earns, pays, gets sold junk and disputes it, all on Celo.
        The evidence is on chain. You decide.
      </p>
      <div className="qr w-[min(70vw,440px)] rounded-2xl bg-neutral-900 p-6" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="font-mono text-lg text-neutral-400 break-all">{voteUrl}</p>
      <nav className="flex flex-wrap justify-center gap-6 text-2xl">
        <Link className="underline" href="/live">
          Live log
        </Link>
        <Link className="underline" href="/projector">
          Projector
        </Link>
        <Link className="underline" href={`/vote?r=${encodeURIComponent(round)}`}>
          Vote
        </Link>
      </nav>
      {!redis && <RedisNotice />}
    </main>
  );
}
