import { LiveClient } from '@/components/LiveClient';
import { RedisNotice } from '@/components/RedisNotice';
import { gatewayUrl } from '@/lib/env';
import { DEFAULT_ROUND, RoundId } from '@/lib/keys';
import { getRedis } from '@/lib/redis';
import { currentRound } from '@/lib/store';

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
  const round = r && RoundId.safeParse(r).success ? r : await currentRound().catch(() => DEFAULT_ROUND);
  return <LiveClient round={round} gateway={gatewayUrl()} />;
}
