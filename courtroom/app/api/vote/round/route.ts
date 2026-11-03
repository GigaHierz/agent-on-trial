import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handle, jsonError } from '@/lib/http';
import { isHost } from '@/lib/host';
import { K, RoundId } from '@/lib/keys';
import { requireRedis } from '@/lib/redis';
import { getTally, setCurrentRound } from '@/lib/store';

export const dynamic = 'force-dynamic';

const RoundPost = z.object({
  round: RoundId,
  action: z.enum(['open', 'close', 'reset', 'set', 'current', 'clear']),
  /** clear: 'log' empties the live log only; omitted, the round's log, board, vote and statements all go. */
  only: z.enum(['log']).optional(),
  trust: z.number().int().nonnegative().optional(),
  distrust: z.number().int().nonnegative().optional(),
});

export async function POST(req: NextRequest) {
  if (!isHost(req)) return jsonError('host only', 401);
  return handle(async () => {
    const body = RoundPost.parse(await req.json());
    const r = requireRedis();
    const { round } = body;

    switch (body.action) {
      case 'open':
        await r.set(K.voteOpen(round), '1');
        await r.del(K.voteClosedAt(round));
        break;
      case 'close':
        await r.set(K.voteOpen(round), '0');
        await r.set(K.voteClosedAt(round), new Date().toISOString());
        break;
      case 'reset':
        await r.del(K.tally(round), K.voters(round), K.voteOpen(round), K.voteClosedAt(round));
        break;
      case 'set': {
        const fields: Record<string, number> = {};
        if (body.trust !== undefined) fields.trust = body.trust;
        if (body.distrust !== undefined) fields.distrust = body.distrust;
        if (Object.keys(fields).length === 0) return jsonError('set needs trust and/or distrust', 400);
        await r.hset(K.tally(round), fields);
        break;
      }
      case 'current':
        await setCurrentRound(round);
        break;
      case 'clear':
        // Rehearsal rounds before the show: a clean live log, board and vote.
        if (body.only === 'log') await r.del(K.log(round));
        else await r.del(K.log(round), K.evidence(round), K.tally(round), K.voters(round), K.voteOpen(round), K.voteClosedAt(round), K.statements(round));
        break;
    }
    return NextResponse.json(await getTally(round));
  });
}
