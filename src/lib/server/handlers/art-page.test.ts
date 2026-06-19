/**
 * Unit tests for /api/art-page handler.
 *
 * @harpe/sources is fully mocked — no network calls, no HF dataset.
 * @harpe/core is mocked at the functions the handler uses so ranking is
 * a transparent pass-through (identity) and qualityScore returns a
 * deterministic value; this lets us assert on items without tying the
 * tests to internal ranking math.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @harpe/sources before any imports so the handler gets the stub.
vi.mock('@harpe/sources', () => ({
  fetchDumpPage: vi.fn(),
}));

// Mock @harpe/core: rankResults passes items through unchanged so tests can
// assert on the exact items returned by fetchDumpPage; qualityScore is a
// constant so ranking order is deterministic.
vi.mock('@harpe/core', () => ({
  rankResults: vi.fn((items: unknown[]) => items),
  qualityScore: vi.fn(() => 0),
}));

// Mock the guard — same pattern as art-stream.test.ts and preview.test.ts.
vi.mock('../guard.js', () => {
  // enforceRateLimit/sendGuardError are composed from the mocked rateLimit/clientIp
  // so existing cases (rateLimit.mockImplementation(throw GuardError)) still drive them.
  class GuardError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
      this.name = 'GuardError';
    }
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

import handler from './art-page.js';
import { fetchDumpPage } from '@harpe/sources';
import { rankResults } from '@harpe/core';
import { rateLimit, GuardError } from '../guard.js';

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const mFetchDumpPage = vi.mocked(fetchDumpPage);
const mRateLimit = vi.mocked(rateLimit);
const mRankResults = vi.mocked(rankResults);

// ─── Response stub (mirrors preview.test.ts / kg-entities.test.ts style) ─────

function makeRes() {
  const r: {
    _status: number;
    _body: unknown;
    headers: Record<string, string>;
    setHeader(k: string, v: string): void;
    status(c: number): typeof r;
    json(body: unknown): typeof r;
  } = {
    _status: 0,
    _body: undefined,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this._status = c; return this; },
    json(body) { this._body = body; return this; },
  };
  return r;
}

function makeReq(
  q: string | undefined,
  page: string | undefined,
  method = 'GET',
) {
  const query: Record<string, string> = {};
  if (q !== undefined) query.q = q;
  if (page !== undefined) query.page = page;
  return { method, query, headers: {} } as never;
}

// A minimal ArtItem-shaped object for happy-path assertions.
const fakeItem = (id = 'wikidata-1') => ({
  id,
  title: 'Starry Night',
  artist: 'Van Gogh',
  thumbUrl: 't.jpg',
  previewUrl: 'p.jpg',
  fullUrl: 'f.jpg',
  source: 'wikidata' as const, // narrow to the ArtItem source union (not widened string)
  isPublicDomain: true,
  dimensions: '',
  format: 'jpeg',
  lossless: false,
  downloads: [],
});

beforeEach(() => {
  mFetchDumpPage.mockReset();
  mRateLimit.mockResolvedValue(undefined);
  mRankResults.mockImplementation((items) => items as never);
  // Default: a valid dataset is configured (handler reads process.env directly).
  process.env.HARPE_DUMP_DATASET = 'NullSense/harpe-art';
});

// ─── Method guard ─────────────────────────────────────────────────────────────

describe('art-page handler — method guard', () => {
  it('returns 405 for POST requests', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2', 'POST'), r as never);
    expect(r._status).toBe(405);
    expect((r._body as { error: string }).error).toMatch(/method not allowed/i);
  });

  it('returns 405 for PUT requests', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2', 'PUT'), r as never);
    expect(r._status).toBe(405);
  });

  it('does not call fetchDumpPage on a non-GET request', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2', 'POST'), r as never);
    expect(mFetchDumpPage).not.toHaveBeenCalled();
  });
});

// ─── Missing / empty query param ─────────────────────────────────────────────

describe('art-page handler — query validation', () => {
  it('returns 400 when ?q= is absent', async () => {
    const r = makeRes();
    await handler({ method: 'GET', query: {}, headers: {} } as never, r as never);
    expect(r._status).toBe(400);
    expect((r._body as { error: string }).error).toMatch(/missing/i);
  });

  it('returns 400 when ?q= is an empty string', async () => {
    const r = makeRes();
    await handler(makeReq('', '2'), r as never);
    expect(r._status).toBe(400);
    expect((r._body as { error: string }).error).toMatch(/missing/i);
  });

  it('returns 400 when ?q= is whitespace only', async () => {
    const r = makeRes();
    await handler(makeReq('   ', '2'), r as never);
    expect(r._status).toBe(400);
  });

  it('does not call fetchDumpPage on an empty query', async () => {
    const r = makeRes();
    await handler(makeReq('', '2'), r as never);
    expect(mFetchDumpPage).not.toHaveBeenCalled();
  });
});

// ─── Page clamping ────────────────────────────────────────────────────────────

describe('art-page handler — page clamping', () => {
  beforeEach(() => {
    mFetchDumpPage.mockResolvedValue({ items: [], hasMore: false, total: 0 });
  });

  it('clamps page=0 to 1', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '0'), r as never);
    expect(r._status).toBe(200);
    expect((r._body as { page: number }).page).toBe(1);
  });

  it('clamps page=-1 to 1', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '-1'), r as never);
    expect((r._body as { page: number }).page).toBe(1);
  });

  it('clamps NaN page to 1', async () => {
    const r = makeRes();
    await handler(makeReq('monet', 'banana'), r as never);
    expect((r._body as { page: number }).page).toBe(1);
  });

  it('clamps page>50 to 50 (nearest valid, not the wrong page 1)', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '51'), r as never);
    expect((r._body as { page: number }).page).toBe(50);
  });

  it('clamps page=50 boundary: page 50 is valid and passes through', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '50'), r as never);
    expect((r._body as { page: number }).page).toBe(50);
  });

  it('passes through a valid page number (page=5)', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '5'), r as never);
    expect((r._body as { page: number }).page).toBe(5);
  });

  it('passes through a valid page number (page=1)', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '1'), r as never);
    expect((r._body as { page: number }).page).toBe(1);
  });

  it('clamps a float page (1.5) to 1 since it is not an integer', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '1.5'), r as never);
    // Number('1.5') = 1.5, Number.isInteger(1.5) = false → clamped to 1
    expect((r._body as { page: number }).page).toBe(1);
  });

  it('clamps when ?page= is absent entirely', async () => {
    const r = makeRes();
    // No page param → pageRaw = 0 → clamp to 1
    await handler(makeReq('monet', undefined), r as never);
    expect((r._body as { page: number }).page).toBe(1);
  });
});

// ─── Empty dataset environment ────────────────────────────────────────────────

describe('art-page handler — empty dataset env', () => {
  beforeEach(() => {
    delete process.env.HARPE_DUMP_DATASET; // simulate no dump dataset configured
  });

  it('returns 200 with empty items when no dataset is configured', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(r._status).toBe(200);
    expect((r._body as { items: unknown[] }).items).toEqual([]);
  });

  it('returns hasMore:false when no dataset is configured', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect((r._body as { hasMore: boolean }).hasMore).toBe(false);
  });

  it('returns total:0 when no dataset is configured', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect((r._body as { total: number }).total).toBe(0);
  });

  it('does not call fetchDumpPage when dataset is empty', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(mFetchDumpPage).not.toHaveBeenCalled();
  });

  it('still returns the clamped page number in the response', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '7'), r as never);
    expect((r._body as { page: number }).page).toBe(7);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('art-page handler — happy path', () => {
  const items = [fakeItem('wikidata-1'), fakeItem('wikidata-2')];

  beforeEach(() => {
    mFetchDumpPage.mockResolvedValue({ items, hasMore: true, total: 42 });
  });

  it('returns 200 with the ranked items, page, hasMore and total', async () => {
    const r = makeRes();
    await handler(makeReq('van gogh', '3'), r as never);
    expect(r._status).toBe(200);
    const body = r._body as { items: unknown[]; page: number; hasMore: boolean; total: number };
    expect(body.items).toEqual(items);
    expect(body.page).toBe(3);
    expect(body.hasMore).toBe(true);
    expect(body.total).toBe(42);
  });

  it('calls fetchDumpPage with the dataset, trimmed query and clamped page', async () => {
    const r = makeRes();
    await handler(makeReq('  van gogh  ', '4'), r as never);
    expect(mFetchDumpPage).toHaveBeenCalledWith('NullSense/harpe-art', 'van gogh', 4);
  });

  it('passes the fetchDumpPage items through rankResults', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(mRankResults).toHaveBeenCalledWith(items, 'monet', expect.objectContaining({ qualityOf: expect.any(Function) }));
  });

  it('returns items in the order rankResults produces', async () => {
    const reversed = [...items].reverse();
    mRankResults.mockReturnValueOnce(reversed as never);
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect((r._body as { items: unknown[] }).items).toEqual(reversed);
  });

  it('sets a CDN cache header on a successful response', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(r.headers['Cache-Control']).toMatch(/s-maxage=3600/);
  });

  it('sets CORS Access-Control-Allow-Origin: *', async () => {
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('handles hasMore:false from fetchDumpPage correctly', async () => {
    mFetchDumpPage.mockResolvedValueOnce({ items, hasMore: false, total: 5 });
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect((r._body as { hasMore: boolean }).hasMore).toBe(false);
  });
});

// ─── fetchDumpPage throws → 502 ───────────────────────────────────────────────

describe('art-page handler — fetchDumpPage failure', () => {
  it('returns 502 when fetchDumpPage throws', async () => {
    mFetchDumpPage.mockRejectedValue(new Error('HF unreachable'));
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(r._status).toBe(502);
    expect((r._body as { error: string }).error).toMatch(/dump page fetch failed/i);
  });

  it('returns 502 when fetchDumpPage rejects with a non-Error value', async () => {
    mFetchDumpPage.mockRejectedValue('timeout string');
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(r._status).toBe(502);
  });

  it('sets no-store Cache-Control on a 502 error response', async () => {
    mFetchDumpPage.mockRejectedValue(new Error('circuit open'));
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(r.headers['Cache-Control']).toBe('no-store');
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe('art-page handler — rate limiting', () => {
  it('returns 429 when the rate limiter throws GuardError(429)', async () => {
    mRateLimit.mockRejectedValue(new GuardError(429, 'Rate limit exceeded — try again in a minute'));
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(r._status).toBe(429);
    expect((r._body as { error: string }).error).toMatch(/rate limit/i);
  });

  it('does not call fetchDumpPage when rate-limited', async () => {
    mRateLimit.mockRejectedValue(new GuardError(429, 'Rate limit exceeded — try again in a minute'));
    const r = makeRes();
    await handler(makeReq('monet', '2'), r as never);
    expect(mFetchDumpPage).not.toHaveBeenCalled();
  });

  it('rethrows a non-GuardError from rateLimit', async () => {
    mRateLimit.mockRejectedValue(new Error('Redis infra failure'));
    const r = makeRes();
    await expect(handler(makeReq('monet', '2'), r as never)).rejects.toThrow('Redis infra failure');
  });
});
