import { Redis } from '@upstash/redis';
import { memoryRedis } from './memory-redis';

let client: Redis | null = null;

export class RedisMissing extends Error {
  constructor() {
    super('redis not configured');
    this.name = 'RedisMissing';
  }
}

/**
 * Upstash REST credentials. The Vercel Marketplace install ("Upstash for Redis")
 * injects KV_REST_API_URL / KV_REST_API_TOKEN; a database made on upstash.com
 * ships UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Either pair works.
 */
function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

/** A local run without Upstash: COURTROOM_MEMORY=1 keeps the store in this process. */
function memoryMode(): boolean {
  return !credentials() && process.env.COURTROOM_MEMORY === '1';
}

export function redisConfigured(): boolean {
  return credentials() !== null || memoryMode();
}

/** Null when the Upstash env is missing. Pages use this to render a notice. */
export function getRedis(): Redis | null {
  if (memoryMode()) return memoryRedis() as unknown as Redis;
  const creds = credentials();
  if (!creds) return null;
  if (!client) client = new Redis(creds);
  return client;
}

/** Throws RedisMissing, which the route wrapper turns into a 500 JSON error. */
export function requireRedis(): Redis {
  const r = getRedis();
  if (!r) throw new RedisMissing();
  return r;
}
