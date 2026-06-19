/**
 * Shared optional Upstash Redis client for the knowledge-graph entity endpoints
 * (artist / depicts). Same env + lazy-singleton pattern as analyze.ts; null when
 * unconfigured so handlers degrade to a live HF CDN fetch with no cache.
 */
import type { VercelResponse } from '../vercel.js';

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

const ENTITY_CACHE_CONTROL = 'public, s-maxage=86400, stale-while-revalidate=86400';

/**
 * Serve a knowledge-graph entity payload through the Upstash cache: a cache hit is
 * returned with the 24h CDN headers; a miss runs `compute`, 404s (no-store) when it
 * yields null, otherwise caches and returns it. The shared get→compute→404→set→headers
 * flow behind /api/artist and /api/depicts. `notFound` is the 404 error message.
 */
export async function withEntityCache<T>(
  res: VercelResponse,
  cacheKey: string,
  notFound: string,
  compute: () => Promise<T | null>,
): Promise<void> {
  const redis = await getEntityRedis();
  if (redis) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) {
      res.setHeader('Cache-Control', ENTITY_CACHE_CONTROL);
      res.status(200).json(typeof hit === 'string' ? JSON.parse(hit) : hit);
      return;
    }
  }
  const payload = await compute();
  if (payload == null) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: notFound });
    return;
  }
  if (redis) await redis.set(cacheKey, JSON.stringify(payload), { ex: ENTITY_TTL_S }).catch(() => {});
  res.setHeader('Cache-Control', ENTITY_CACHE_CONTROL);
  res.status(200).json(payload);
}
