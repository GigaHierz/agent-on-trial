export function RedisNotice() {
  return (
    <div className="rounded-xl border border-mint/40 bg-mint/10 px-5 py-4 text-left text-base text-mint">
      <p className="font-semibold">Redis is not configured.</p>
      <p className="text-mint/80">
        Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel Upstash) or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Until then the
        live log, evidence and vote stay empty.
      </p>
    </div>
  );
}
