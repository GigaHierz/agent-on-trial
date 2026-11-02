import { ChatClient } from '@/components/ChatClient';
import { RedisNotice } from '@/components/RedisNotice';
import { gatewayUrl } from '@/lib/env';
import { getRedis } from '@/lib/redis';
import { resolveRounds } from '@/lib/view-round';

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
  const { round, live } = await resolveRounds(r);
  return <ChatClient round={round} voteRound={live} gateway={gatewayUrl()} />;
}
