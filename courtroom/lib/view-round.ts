import { cookies } from 'next/headers';
import { DEFAULT_ROUND, RoundId } from './keys';
import { getRedis } from './redis';
import { currentRound } from './store';

export const VIEW_COOKIE = 'viewRound';

/**
 * Which round a page shows. Order: an explicit query value, then the
 * Live / Test data switch (a cookie), then the live round set on the bench.
 * The vote never uses this; it always follows the live round.
 */
export async function resolveRounds(queryRound?: string): Promise<{ round: string; live: string }> {
  const live = getRedis() ? await currentRound().catch(() => DEFAULT_ROUND) : DEFAULT_ROUND;
  const fromCookie = (await cookies()).get(VIEW_COOKIE)?.value;
  const pick = [queryRound, fromCookie].find((v) => v && RoundId.safeParse(v).success);
  return { round: pick ?? live, live };
}
