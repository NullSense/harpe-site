/**
 * Unit tests for reverse.ts — all deterministic (no real network calls).
 * Uses vi.stubGlobal to mock fetch and vi.stubEnv for the API key.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { reverseSearch } from './reverse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid SauceNAO JSON response with one result. */
function makeSauceResponse(overrides: {
  similarity?: number;
  thumbnail?: string;
  title?: string;
  ext_urls?: string[];
  index_name?: string;
  status?: number;
} = {}) {
  return {
    header: { status: overrides.status ?? 0 },
    results: [
      {
        header: {
          similarity: overrides.similarity ?? 92.5,
          thumbnail: overrides.thumbnail ?? 'https://img.saucenao.com/thumb.jpg',
          index_name: overrides.index_name ?? 'Index #9 - Danbooru',
        },
        data: {
          ext_urls: overrides.ext_urls ?? ['https://danbooru.donmai.us/posts/123'],
          title: overrides.title ?? 'Autumn Leaves',
        },
      },
    ],
  };
}

/** Stub fetch to return a JSON body with the given status. */
function stubFetch(body: unknown, httpStatus = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: () => Promise.resolve(body),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// No-key → [] path
// ---------------------------------------------------------------------------
describe('reverseSearch — no key configured', () => {
  it('returns [] when SAUCENAO_API_KEY is absent and key files are missing', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', '');
    // Note: key files don't exist in the test environment, so saucenaoKey() → ''
    const results = await reverseSearch('https://example.com/image.jpg');
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Happy-path: SauceNAO → TSV mapping
// ---------------------------------------------------------------------------
describe('reverseSearch — SauceNAO → TSV mapping', () => {
  it('maps a single result to the correct TSV row', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key-abc');
    stubFetch(makeSauceResponse({ similarity: 92.5, title: 'Autumn Leaves', ext_urls: ['https://danbooru.donmai.us/posts/123'], thumbnail: 'https://img.saucenao.com/thumb.jpg' }));

    const results = await reverseSearch('https://example.com/img.jpg');
    expect(results).toHaveLength(1);
    const [engine, sim, title, url, thumb] = results[0].split('\t');
    expect(engine).toBe('SauceNAO');
    expect(sim).toBe('93%'); // Math.round(92.5)
    expect(title).toBe('Autumn Leaves');
    expect(url).toBe('https://danbooru.donmai.us/posts/123');
    expect(thumb).toBe('https://img.saucenao.com/thumb.jpg');
  });

  it('falls back to index_name when title is missing', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    stubFetch(makeSauceResponse({ title: '', index_name: 'Index #9 - Danbooru' }));

    const results = await reverseSearch('https://example.com/img.jpg');
    const [, , title] = results[0].split('\t');
    expect(title).toBe('Index #9 - Danbooru');
  });

  it('deduplicates by query-stripped URL — keeps best similarity', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    // Two results with same base URL but different query strings
    stubFetch({
      header: { status: 0 },
      results: [
        {
          header: { similarity: 80, thumbnail: '', index_name: '' },
          data: { ext_urls: ['https://danbooru.donmai.us/posts/1?q=a'], title: 'Low' },
        },
        {
          header: { similarity: 95, thumbnail: '', index_name: '' },
          data: { ext_urls: ['https://danbooru.donmai.us/posts/1?q=b'], title: 'High' },
        },
      ],
    });

    const results = await reverseSearch('https://example.com/img.jpg');
    // Should deduplicate to one row (same base URL)
    expect(results).toHaveLength(1);
    const [, sim] = results[0].split('\t');
    expect(sim).toBe('95%');
  });

  it('sorts by similarity descending within the same priority tier', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    stubFetch({
      header: { status: 0 },
      results: [
        { header: { similarity: 70, thumbnail: '', index_name: '' }, data: { ext_urls: ['https://example.com/a'], title: 'A' } },
        { header: { similarity: 95, thumbnail: '', index_name: '' }, data: { ext_urls: ['https://example.com/b'], title: 'B' } },
        { header: { similarity: 85, thumbnail: '', index_name: '' }, data: { ext_urls: ['https://example.com/c'], title: 'C' } },
      ],
    });

    const results = await reverseSearch('https://example.com/img.jpg');
    expect(results).toHaveLength(3);
    const sims = results.map((r) => parseInt(r.split('\t')[1], 10));
    expect(sims[0]).toBeGreaterThanOrEqual(sims[1]);
    expect(sims[1]).toBeGreaterThanOrEqual(sims[2]);
  });

  it('places original-source domains before generic ones', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    stubFetch({
      header: { status: 0 },
      results: [
        // Generic domain, higher similarity
        { header: { similarity: 99, thumbnail: '', index_name: '' }, data: { ext_urls: ['https://generic.example.com/img'], title: 'Generic' } },
        // Original source domain, lower similarity
        { header: { similarity: 70, thumbnail: '', index_name: '' }, data: { ext_urls: ['https://danbooru.donmai.us/posts/1'], title: 'Danbooru' } },
      ],
    });

    const results = await reverseSearch('https://example.com/img.jpg');
    expect(results).toHaveLength(2);
    // Danbooru (original source, priority 0) should come first despite lower similarity
    expect(results[0]).toContain('danbooru.donmai.us');
  });

  it('skips results with no valid ext_urls', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    stubFetch({
      header: { status: 0 },
      results: [
        { header: { similarity: 90, thumbnail: '', index_name: '' }, data: { ext_urls: [], title: 'No URLs' } },
        { header: { similarity: 80, thumbnail: '', index_name: '' }, data: { ext_urls: ['https://example.com/ok'], title: 'Has URL' } },
      ],
    });

    const results = await reverseSearch('https://example.com/img.jpg');
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('Has URL');
  });

  it('returns [] when SauceNAO HTTP status is non-OK', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    stubFetch({}, 503);

    const results = await reverseSearch('https://example.com/img.jpg');
    expect(results).toEqual([]);
  });

  it('returns [] when SauceNAO response status > 0 (quota hit)', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    stubFetch({ header: { status: 1, message: 'Daily limit reached' }, results: [] });

    const results = await reverseSearch('https://example.com/img.jpg');
    expect(results).toEqual([]);
  });

  it('returns [] when fetch throws (network error)', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const results = await reverseSearch('https://example.com/img.jpg');
    expect(results).toEqual([]);
  });

  it('truncates title to 70 characters', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    const longTitle = 'A'.repeat(100);
    stubFetch(makeSauceResponse({ title: longTitle }));

    const results = await reverseSearch('https://example.com/img.jpg');
    const [, , title] = results[0].split('\t');
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('uses similarity "~" for unknown/unparseable similarity', async () => {
    vi.stubEnv('SAUCENAO_API_KEY', 'test-key');
    stubFetch({
      header: { status: 0 },
      results: [
        { header: { similarity: 'not-a-number', thumbnail: '', index_name: '' }, data: { ext_urls: ['https://example.com/x'], title: 'X' } },
      ],
    });

    const results = await reverseSearch('https://example.com/img.jpg');
    const [, sim] = results[0].split('\t');
    expect(sim).toBe('~');
  });
});
