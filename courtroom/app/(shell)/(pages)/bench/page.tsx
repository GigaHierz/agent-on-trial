import { BenchClient } from '@/components/BenchClient';
import { HostLogin } from '@/components/HostLogin';
import { RedisNotice } from '@/components/RedisNotice';
import { baseUrl } from '@/lib/env';
import { isHostSession } from '@/lib/host-session';
import { DEFAULT_ROUND } from '@/lib/keys';
import { getRedis } from '@/lib/redis';
import { currentRound } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function BenchPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const { denied } = await searchParams;
  if (!(await isHostSession())) return <HostLogin to="/bench" denied={denied === '1'} />;
  if (!getRedis()) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <RedisNotice />
      </main>
    );
  }
  const round = await currentRound().catch(() => DEFAULT_ROUND);
  return <BenchClient round={round} baseUrl={baseUrl()} />;
}
