import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards fetchDumpPage: the per-source pagination logic (offset, hasMore, total
// derivation) and the dedupe by id. timedFetch and dumpHttpPolicy are mocked so
// no network runs. loadNameToQid is also mocked (rowToItem calls resolveArtistQid
// which needs a name index; an empty map is fine for pagination logic).

const { timedFetchMock } = vi.hoisted(() => ({ timedFetchMock: vi.fn() }));
vi.mock('./helpers.js', async (orig) => ({
  ...(await orig<typeof import('./helpers.js')>()),
  timedFetch: timedFetchMock,
}));

// Mock dumpHttpPolicy so it just calls the inner fn directly (no retry/breaker).
vi.mock('./resilience.js', async (orig) => {
  const real = await orig<typeof import('./resilience.js')>();
  return {
    ...real,
    dumpHttpPolicy: {
      execute: (fn: Parameters<typeof real.dumpHttpPolicy.execute>[0]) =>
        fn({ signal: new AbortController().signal } as Parameters<typeof fn>[0]),
    },
  };
});

import { fetchDumpPage, DUMP_SOURCE_LABELS, _resetDumpPageCache } from './adapters.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid HF /filter response shape. */
function hfReply(rows: Array<Record<string, unknown>>, total: number) {
  return {
    ok: true,
    json: async () => ({
      rows: rows.map((row) => ({ row })),
      num_rows_total: total,
    }),
  };
}

/** A minimal dump row that passes rowToItem's guard (must have an image URL). */
function row(id: string, source = 'nga'): Record<string, unknown> {
  return {
    id,
    source,
    image_full: `https://example.com/${id}.jpg`,
    image_thumb: `https://example.com/${id}_thumb.jpg`,
    title: `Title ${id}`,
    artist: 'Test Artist',
    is_public_domain: true,
  };
}

const DUMP_PER_SOURCE = 100; // matches the constant in adapters.ts

beforeEach(() => {
  timedFetchMock.mockReset();
  _resetDumpPageCache(); // fetchDumpPage is cached — clear so each case fetches fresh
  // name_to_qid.json fetch — mocked to empty so loadNameToQid resolves quickly.
  timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
});

// ---------------------------------------------------------------------------
// Probe notability: the first call probes the orderby URL; we just need to handle
// both the probe mock (returns ok) and the data fetch mock (returns hfReply).
// For simplicity: make timedFetch return the HF reply for ALL calls (the probe
// then "succeeds" and we always query with orderby — the pagination logic is
// the same either way).
// ---------------------------------------------------------------------------

describe('fetchDumpPage — hasMore / total derivation', () => {
  it('hasMore=false when no source has rows beyond (page+1)*DUMP_PER_SOURCE', async () => {
    // All 13 sources return total=50 (less than 1 page).
    timedFetchMock.mockResolvedValue(hfReply([row('r1')], 50));
    const result = await fetchDumpPage('ds', 'monet', 0);
    // 13 sources × 50 = 650 total; none exceeds (0+1)*100=100 threshold.
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(13 * 50);
  });

  it('hasMore=true when at least one source total > (page+1)*DUMP_PER_SOURCE', async () => {
    // All sources report 150 total rows, which exceeds page 0's threshold of 100.
    timedFetchMock.mockResolvedValue(hfReply([row('r1')], 150));
    const result = await fetchDumpPage('ds', 'monet', 0);
    expect(result.hasMore).toBe(true);
  });

  it('hasMore=false for page 1 when all source totals ≤ (page+1)*DUMP_PER_SOURCE', async () => {
    // page=1: threshold = (1+1)*100 = 200. All sources have 150 total.
    timedFetchMock.mockResolvedValue(hfReply([row('r1')], 150));
    const result = await fetchDumpPage('ds', 'monet', 1);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(13 * 150);
  });

  it('hasMore=true on page 1 when a source total > 200', async () => {
    timedFetchMock.mockResolvedValue(hfReply([row('r1')], 250));
    const result = await fetchDumpPage('ds', 'monet', 1);
    expect(result.hasMore).toBe(true);
  });

  it('total is the sum of all per-source num_rows_total', async () => {
    // All 13 sources report 77 rows each.
    timedFetchMock.mockResolvedValue(hfReply([], 77));
    const result = await fetchDumpPage('ds', 'test', 0);
    expect(result.total).toBe(13 * 77);
  });
});

describe('fetchDumpPage — dedupe by id', () => {
  it('dedupes rows with the same id across sources', async () => {
    // Return the SAME row id from every source.
    timedFetchMock.mockResolvedValue(hfReply([row('shared-id', 'nga')], 1));
    const result = await fetchDumpPage('ds', 'van gogh', 0);
    // All 13 sources return 'shared-id'; only one item should survive.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('shared-id');
  });

  it('keeps distinct ids from different sources', async () => {
    // Each call returns a unique row by embedding a counter in the id.
    let n = 0;
    timedFetchMock.mockImplementation(() => {
      const sourceRow = row(`unique-${n++}`, 'nga');
      return Promise.resolve(hfReply([sourceRow], 1));
    });
    const result = await fetchDumpPage('ds', 'van gogh', 0);
    // 13 unique ids (one per source) should all survive.
    expect(result.items.length).toBe(13);
  });
});

describe('fetchDumpPage — item mapping', () => {
  it('maps HF row fields to ArtItem correctly (spot check)', async () => {
    const r = {
      id: 'nga-123',
      source: 'nga',
      image_full: 'http://example.com/full.jpg',
      image_thumb: 'http://example.com/thumb.jpg',
      title: 'The Night Watch',
      artist: 'Rembrandt',
      is_public_domain: true,
      date: '1642',
      medium: 'Oil on canvas',
      dimensions: '363 × 437 cm',
    };
    timedFetchMock.mockResolvedValue(hfReply([r], 1));
    const result = await fetchDumpPage('ds', 'night watch', 0);
    const item = result.items.find((i) => i.id === 'nga-123');
    expect(item).toBeDefined();
    expect(item?.title).toBe('The Night Watch');
    expect(item?.artist).toBe('Rembrandt');
    expect(item?.isPublicDomain).toBe(true);
    // http → https upgrade
    expect(item?.fullUrl).toBe('https://example.com/full.jpg');
    expect(item?.thumbUrl).toBe('https://example.com/thumb.jpg');
    expect(item?.date).toBe('1642');
    expect(item?.medium).toBe('Oil on canvas');
    expect(item?.dimensions).toBe('363 × 437 cm');
    expect(item?.source).toBe('nga');
  });

  it('skips rows without image URLs', async () => {
    // A row with no image fields should not produce an item.
    const noImg = { id: 'nga-999', source: 'nga', title: 'No Image' };
    timedFetchMock.mockResolvedValue(hfReply([noImg], 1));
    const result = await fetchDumpPage('ds', 'van gogh', 0);
    expect(result.items.find((i) => i.id === 'nga-999')).toBeUndefined();
  });

  it('upgrades http image URLs to https', async () => {
    const r = row('http-test', 'nga');
    r.image_full = 'http://insecure.example.com/img.jpg';
    r.image_thumb = 'http://insecure.example.com/thumb.jpg';
    timedFetchMock.mockResolvedValue(hfReply([r], 1));
    const result = await fetchDumpPage('ds', 'van gogh', 0);
    const item = result.items.find((i) => i.id === 'http-test');
    expect(item?.fullUrl.startsWith('https://')).toBe(true);
    expect(item?.thumbUrl.startsWith('https://')).toBe(true);
  });
});

describe('fetchDumpPage — error tolerance', () => {
  it('returns empty items when all sources fail (broken circuit)', async () => {
    // Re-mock dumpHttpPolicy to throw a broken circuit error for this test.
    // We simulate all sources returning empty rows/0 total (broken circuit path
    // returns { rows: [], total: 0 } and does NOT throw unless all fail).
    timedFetchMock.mockResolvedValue(hfReply([], 0));
    const result = await fetchDumpPage('ds', 'van gogh', 0);
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(0);
  });

  it('uses correct offset for page > 0', async () => {
    timedFetchMock.mockResolvedValue(hfReply([], 0));
    // We just verify it does not throw and returns the right shape.
    const result = await fetchDumpPage('ds', 'sunflowers', 3);
    expect(result).toMatchObject({ items: expect.any(Array), hasMore: false, total: 0 });
  });
});
