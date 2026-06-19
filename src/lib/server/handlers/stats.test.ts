/**
 * Deterministic unit tests for the /api/stats handler.
 *
 * Covers:
 *  1. Count assembly: live probes → correct sum (excluding overlap sources).
 *  2. Cache HIT path: Upstash returns stored payload → returned verbatim.
 *  3. Cache MISS → live probe → cache write → response.
 *  4. Fallback path: when all probes fail AND Upstash is absent → seed numbers.
 *  5. Method guard: non-GET returns 405.
 *  6. Rate limit: rateLimit throws → 429 returned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock undici so no real network calls are made ─────────────────────────
vi.mock('undici', () => ({ fetch: vi.fn() }));
import { fetch as undiciFetch } from 'undici';
const mockFetch = undiciFetch as unknown as ReturnType<typeof vi.fn>;

// ─── Mock guard module (rateLimit + clientIp) ──────────────────────────────
vi.mock('../guard.js', () => {
  // enforceRateLimit/sendGuardError are composed from the mocked rateLimit/clientIp
  // so existing cases (rateLimit.mockImplementation(throw GuardError)) still drive them.
  class GuardError extends Error {
    status: number;
    constructor(status: number, msg: string) { super(msg); this.status = status; this.name = 'GuardError'; }
  }
  const rateLimit = vi.fn();
  const clientIp = vi.fn(() => '1.2.3.4');
  const sendGuardError = (res: { setHeader(k: string, v: string): void; status(c: number): { json(b: unknown): unknown } }, e: unknown) => {
    if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); res.status(e.status).json({ error: e.message }); return true; }
    return false;
  };
  const enforceRateLimit = vi.fn(async (_req: { headers: Record<string, unknown> }, res: { setHeader(k: string, v: string): void; status(c: number): { json(b: unknown): unknown } }) => {
    const ip = clientIp();
    try { await rateLimit(ip); return ip; } catch (e) { if (sendGuardError(res, e)) return null; throw e; }
  });
  return { GuardError, rateLimit, clientIp, sendGuardError, enforceRateLimit };
});
import { rateLimit, GuardError } from '../guard.js';
const mockRateLimit = rateLimit as ReturnType<typeof vi.fn>;

// ─── Mock @upstash/redis ──────────────────────────────────────────────────
// vi.mock is hoisted; the factory must be self-contained (no outer-scope refs).
// We expose the mock fns via a shared object that IS accessible after hoisting.
const _redisMock = {
  get: vi.fn(),
  set: vi.fn(),
};

vi.mock('@upstash/redis', () => {
  class Redis {
    // Bind to the shared object so the outer-scope reset calls affect these.
    // The property initializer runs at construction time (after hoisting).
    get(...args: unknown[]) { return _redisMock.get(...args); }
    set(...args: unknown[]) { return _redisMock.set(...args); }
    constructor(_opts: unknown) {}
  }
  return { Redis };
});

const mockRedisGet = _redisMock.get;
const mockRedisSet = _redisMock.set;

// ─── Import the module AFTER mocks are wired ──────────────────────────────
import {
  SEED,
  fetchLiveCounts,
  sumCounts,
  _resetRedisForTest,
} from './stats.js';
import statsHandler from './stats.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeOk(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

function makeReq(method = 'GET'): {
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  url: string;
} {
  return { method, query: {}, headers: { 'x-real-ip': '1.2.3.4' }, url: '/api/stats' };
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (code: number) => { statusCode = code; return res; },
    json: (data: unknown) => { body = data; return res; },
    _headers: headers,
    _status: () => statusCode,
    _body: () => body,
  };
  return res;
}

// ─── Reset singletons between tests ───────────────────────────────────────
// stats.ts uses module-level singletons for the Redis client; reset via
// env manipulation + module cache isn't possible in ESM vi.mock. Instead we
// reset the mock functions and control behaviour via env vars.

beforeEach(() => {
  mockFetch.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRateLimit.mockResolvedValue(undefined);
  // Ensure Upstash env is present so the lazy client initialises for most tests
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  // Reset the Redis singleton so getRedis() re-initialises on each test
  _resetRedisForTest();
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.EUROPEANA_API_KEY;
  delete process.env.HARVARD_API_KEY;
  delete process.env.SMITHSONIAN_API_KEY;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SEED constants', () => {
  it('seed artworks >= 50M', () => {
    expect(SEED.artworks).toBeGreaterThanOrEqual(50_000_000);
  });
  it('seed museumsAndArchives >= 3000', () => {
    expect(SEED.museumsAndArchives).toBeGreaterThanOrEqual(3_000);
  });
  it('seed collections >= 20', () => {
    expect(SEED.collections).toBeGreaterThanOrEqual(20);
  });
  it('seed countries >= 12', () => {
    expect(SEED.countries).toBeGreaterThanOrEqual(12);
  });
});

describe('sumCounts', () => {
  it('excludes the commons key from the total (overlap avoidance)', () => {
    const counts = { aic: 100, commons: 999_999, wikidata: 200 };
    // commons must be excluded
    expect(sumCounts(counts)).toBe(300);
  });

  it('excludes nypl (disabled in prod) from the total', () => {
    const counts = { aic: 100, nypl: 900_000 };
    expect(sumCounts(counts)).toBe(100);
  });

  it('sums all other sources', () => {
    const counts = { aic: 132_136, met: 501_868, cleveland: 68_743 };
    expect(sumCounts(counts)).toBe(132_136 + 501_868 + 68_743);
  });
});

describe('fetchLiveCounts — probe success paths', () => {
  it('uses live AIC total when probe succeeds', async () => {
    // Return valid responses for the probed sources; others fail gracefully
    mockFetch.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.includes('artic.edu')) return makeOk({ pagination: { total: 999 } });
      if (s.includes('metmuseum.org')) return makeOk({ total: 888 });
      if (s.includes('clevelandart.org')) return makeOk({ info: { total: 777 } });
      if (s.includes('vam.ac.uk')) return makeOk({ info: { record_count: 666 } });
      if (s.includes('wellcomecollection.org')) return makeOk({ totalResults: 555 });
      if (s.includes('smk.dk')) return makeOk({ found: 444 });
      if (s.includes('nasjonalmuseet.no')) return makeOk({ total_results: 333 });
      if (s.includes('digitalnz.org')) return makeOk({ search: { result_count: 222 } });
      if (s.includes('wikidata.org')) {
        return makeOk({ results: { bindings: [{ count: { value: '111' } }] } });
      }
      if (s.includes('loc.gov')) return makeOk({ pagination: { total: 100 } });
      // Unknown → fail
      return { ok: false, status: 503 };
    });

    const counts = await fetchLiveCounts();
    expect(counts['aic']).toBe(999);
    expect(counts['met']).toBe(888);
    expect(counts['wikidata']).toBe(111);
  });

  it('falls back to seed when a probe throws', async () => {
    // Only AIC succeeds; everything else fails
    mockFetch.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.includes('artic.edu')) return makeOk({ pagination: { total: 99_999 } });
      throw new Error('network error');
    });

    const counts = await fetchLiveCounts();
    expect(counts['aic']).toBe(99_999);
    // met should have fallen back to seed
    expect(counts['met']).toBeGreaterThan(0); // seed value
  });

  it('uses seed for keyed sources when env vars absent', async () => {
    // No EUROPEANA_API_KEY → probe throws immediately
    const counts = await fetchLiveCounts();
    expect(counts['europeana']).toBeGreaterThan(0); // seed
  });
});

describe('GET /api/stats — handler', () => {
  it('returns 405 for non-GET requests', async () => {
    const req = makeReq('POST');
    const res = makeRes();
    await statsHandler(req as never, res as never);
    expect(res._status()).toBe(405);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    const { GuardError: GE } = await import('../guard.js') as { GuardError: typeof GuardError };
    mockRateLimit.mockRejectedValueOnce(new GE(429, 'Rate limit exceeded — try again in a minute'));
    const req = makeReq('GET');
    const res = makeRes();
    await statsHandler(req as never, res as never);
    expect(res._status()).toBe(429);
  });

  it('returns cached payload when Upstash has a hit', async () => {
    const cached = {
      artworks: 123_456_789,
      museumsAndArchives: 3_500,
      collections: 20,
      countries: 12,
      perSource: { aic: 999 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));
    // No fetch calls expected
    mockFetch.mockRejectedValue(new Error('should not be called'));

    const req = makeReq('GET');
    const res = makeRes();
    await statsHandler(req as never, res as never);

    expect(res._status()).toBe(200);
    const body = res._body() as typeof cached;
    expect(body.artworks).toBe(123_456_789);
    expect(body.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('fetches live counts and writes to cache on a cache miss', async () => {
    mockRedisGet.mockResolvedValueOnce(null); // cache miss
    mockRedisSet.mockResolvedValueOnce('OK');

    // Return minimal valid responses for key probed sources
    mockFetch.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.includes('artic.edu')) return makeOk({ pagination: { total: 132_136 } });
      if (s.includes('metmuseum.org')) return makeOk({ total: 501_868 });
      if (s.includes('clevelandart.org')) return makeOk({ info: { total: 68_743 } });
      if (s.includes('vam.ac.uk')) return makeOk({ info: { record_count: 1_307_410 } });
      if (s.includes('wellcomecollection.org')) return makeOk({ totalResults: 641_973 });
      if (s.includes('smk.dk')) return makeOk({ found: 54_398 });
      if (s.includes('nasjonalmuseet.no')) return makeOk({ total_results: 59_081 });
      if (s.includes('digitalnz.org')) return makeOk({ search: { result_count: 1_198_088 } });
      if (s.includes('wikidata.org')) {
        return makeOk({ results: { bindings: [{ count: { value: '596103' } }] } });
      }
      if (s.includes('loc.gov')) return makeOk({ pagination: { total: 1_219_550 } });
      return { ok: false, status: 503 };
    });

    const req = makeReq('GET');
    const res = makeRes();
    await statsHandler(req as never, res as never);

    expect(res._status()).toBe(200);
    const body = res._body() as { artworks: number; updatedAt: string; perSource: Record<string, number> };
    expect(body.artworks).toBeGreaterThanOrEqual(SEED.artworks);
    expect(typeof body.updatedAt).toBe('string');
    expect(body.perSource).toBeDefined();
    // Cache should have been written
    expect(mockRedisSet).toHaveBeenCalledOnce();
    const [key, , opts] = mockRedisSet.mock.calls[0] as [string, string, { ex: number }];
    expect(key).toBe('stats:v1');
    expect(opts.ex).toBe(86_400); // 24 h
  });

  it('returns seed numbers when all probes fail and Upstash is absent', async () => {
    // Remove Upstash env so getRedis() returns null
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    // All HTTP probes fail
    mockFetch.mockRejectedValue(new Error('network down'));

    const req = makeReq('GET');
    const res = makeRes();
    await statsHandler(req as never, res as never);

    expect(res._status()).toBe(200);
    const body = res._body() as { artworks: number; museumsAndArchives: number };
    // Must never be zero — falls back to seeds
    expect(body.artworks).toBeGreaterThanOrEqual(SEED.artworks);
    expect(body.museumsAndArchives).toBe(SEED.museumsAndArchives);
  });

  it('response includes all required fields', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockRedisSet.mockResolvedValueOnce('OK');
    mockFetch.mockRejectedValue(new Error('offline')); // probes fail → seeds

    const req = makeReq('GET');
    const res = makeRes();
    await statsHandler(req as never, res as never);

    const body = res._body() as Record<string, unknown>;
    for (const field of ['artworks', 'museumsAndArchives', 'collections', 'countries', 'updatedAt']) {
      expect(body).toHaveProperty(field);
    }
  });
});
