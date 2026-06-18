/**
 * Shared optional Upstash Redis client for the knowledge-graph entity endpoints
 * (artist / depicts). Same env + lazy-singleton pattern as analyze.ts; null when
 * unconfigured so handlers degrade to a live HF CDN fetch with no cache.
 */
type RedisLike = {
  get: (k: string) => Promise<unknown>;
  set: (k: string, v: string, o: { ex: number }) => Promise<unknown>;
};

let _redis: RedisLike | null | undefined;

export async function getEntityRedis(): Promise<RedisLike | null> {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) { _redis = null; return null; }
  try {
    const { Redis } = await import('@upstash/redis');
    _redis = new Redis({ url, token }) as unknown as RedisLike;
  } catch { _redis = null; }
  return _redis;
}

/** Entity pages change only at ingest time → cache hard (24h). */
export const ENTITY_TTL_S = 86_400;
