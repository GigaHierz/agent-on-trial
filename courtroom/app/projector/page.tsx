import { Nav } from '@/components/Nav';
import { ProjectorClient } from '@/components/ProjectorClient';
import { RedisNotice } from '@/components/RedisNotice';
import { baseUrl, gatewayUrl } from '@/lib/env';
import { DEFAULT_ROUND, RoundId } from '@/lib/keys';
import { qrSvg } from '@/lib/qr';
import { getRedis } from '@/lib/redis';
import { currentRound } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** The stage board: nav on top, no footer, the tally band fills that role. */
export default async function ProjectorPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  const redis = getRedis();
  if (!redis) {
    return (
      <>
        <Nav />
        <main className="mx-auto max-w-2xl px-6 py-12">
          <RedisNotice />
        </main>
      </>
    );
  }
  // Exhibits follow the round in the URL (the nav switch); the vote, the QR
  // and the tally always follow the live round set on the bench.
  const live = await currentRound().catch(() => DEFAULT_ROUND);
  const round = r && RoundId.safeParse(r).success ? r : live;
  const svg = await qrSvg(`${baseUrl()}/vote`);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Nav />
      <ProjectorClient round={round} voteRound={live} gateway={gatewayUrl()} qrSvg={svg} />
    </div>
  );
}
