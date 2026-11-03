/**
 * COURTROOM_MEMORY=1, for a local run with no Upstash: the few Redis calls the
 * courtroom makes, kept in this process. Values are stored as strings, as they
 * reach Upstash; the store's readers already parse strings. Everything is lost
 * on restart. Never for a deployment: each serverless instance would have its own.
 */
type Value = string | string[] | Map<string, string> | Set<string>;

class MemoryRedis {
  private data = new Map<string, Value>();

  async get<T>(key: string): Promise<T | null> {
    const v = this.data.get(key);
    return (typeof v === 'string' ? v : null) as T | null;
  }

  async set(key: string, value: unknown): Promise<'OK'> {
    this.data.set(key, String(value));
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.data.delete(k)).length;
  }

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const list = this.list(key);
    list.push(...values.map(String));
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.list(key);
    this.data.set(key, list.slice(...range(list.length, start, stop)));
    return 'OK';
  }

  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    const list = this.list(key);
    return list.slice(...range(list.length, start, stop)) as T[];
  }

  async hgetall<T>(key: string): Promise<T | null> {
    const h = this.data.get(key);
    return (h instanceof Map && h.size ? Object.fromEntries(h) : null) as T | null;
  }

  async hset(key: string, fields: Record<string, unknown>): Promise<number> {
    const h = this.hash(key);
    let added = 0;
    for (const [f, v] of Object.entries(fields)) {
      if (!h.has(f)) added++;
      h.set(f, String(v));
    }
    return added;
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    const h = this.hash(key);
    const n = Number.parseInt(h.get(field) ?? '0', 10) + by;
    h.set(field, String(n));
    return n;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let s = this.data.get(key);
    if (!(s instanceof Set)) this.data.set(key, (s = new Set<string>()));
    const before = s.size;
    for (const m of members) s.add(m);
    return s.size - before;
  }

  async scard(key: string): Promise<number> {
    const s = this.data.get(key);
    return s instanceof Set ? s.size : 0;
  }

  pipeline() {
    const queued: (() => Promise<unknown>)[] = [];
    const p = {
      hgetall: (key: string) => (queued.push(() => this.hgetall(key)), p),
      scard: (key: string) => (queued.push(() => this.scard(key)), p),
      get: (key: string) => (queued.push(() => this.get(key)), p),
      exec: async <T>() => (await Promise.all(queued.map((q) => q()))) as T,
    };
    return p;
  }

  private list(key: string): string[] {
    const v = this.data.get(key);
    if (Array.isArray(v)) return v;
    const fresh: string[] = [];
    this.data.set(key, fresh);
    return fresh;
  }

  private hash(key: string): Map<string, string> {
    const v = this.data.get(key);
    if (v instanceof Map) return v;
    const fresh = new Map<string, string>();
    this.data.set(key, fresh);
    return fresh;
  }
}

/** Redis LRANGE/LTRIM indexes (inclusive, negative from the end) as slice bounds. */
function range(len: number, start: number, stop: number): [number, number] {
  const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
  const e = stop < 0 ? len + stop + 1 : Math.min(stop + 1, len);
  return [s, Math.max(s, e)];
}

/** One store per server process, across dev reloads and route bundles. */
export function memoryRedis(): MemoryRedis {
  const g = globalThis as { __courtroomMemoryRedis?: MemoryRedis };
  return (g.__courtroomMemoryRedis ??= new MemoryRedis());
}
