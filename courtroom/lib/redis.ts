import { Redis } from '@upstash/redis';
import { memoryRedis } from './memory-redis';

let client: Redis | null = null;

export class RedisMissing extends Error {
  constructor() {
    super('redis not configured');
    this.name = 'RedisMissing';
  }
}

function upstashConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/** A local run without Upstash: COURTROOM_MEMORY=1 keeps the store in this process. */
function memoryMode(): boolean {
  return !upstashConfigured() && process.env.COURTROOM_MEMORY === '1';
}

export function redisConfigured(): boolean {
  return upstashConfigured() || memoryMode();
}

/** Null when the Upstash env is missing. Pages use this to render a notice. */
export function getRedis(): Redis | null {
  if (memoryMode()) return memoryRedis() as unknown as Redis;
  if (!upstashConfigured()) return null;
  if (!client) client = Redis.fromEnv();
  return client;
}

/** Throws RedisMissing, which the route wrapper turns into a 500 JSON error. */
export function requireRedis(): Redis {
  const r = getRedis();
  if (!r) throw new RedisMissing();
  return r;
}
