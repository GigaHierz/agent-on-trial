import { LiveClient } from '@/components/LiveClient';
import { RedisNotice } from '@/components/RedisNotice';
import { gatewayUrl } from '@/lib/env';
import { getRedis } from '@/lib/redis';
import { resolveRounds } from '@/lib/view-round';

export const dynamic = 'force-dynamic';

export default async function LivePage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  const redis = getRedis();
  if (!redis) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <RedisNotice />
      </main>
    );
  }
  const { round, live } = await resolveRounds(r);
  return <LiveClient round={round} voteRound={live} gateway={gatewayUrl()} />;
}
