import { ChatClient } from '@/components/ChatClient';
import { RedisNotice } from '@/components/RedisNotice';
import { gatewayUrl } from '@/lib/env';
import { DEFAULT_ROUND, RoundId } from '@/lib/keys';
import { getRedis } from '@/lib/redis';
import { currentRound } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** The same live log as /live, rendered as a conversation between the host and the defendant. */
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  if (!getRedis()) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <RedisNotice />
      </main>
    );
  }
  const live = await currentRound().catch(() => DEFAULT_ROUND);
  const round = r && RoundId.safeParse(r).success ? r : live;
  return <ChatClient round={round} voteRound={live} gateway={gatewayUrl()} />;
}
