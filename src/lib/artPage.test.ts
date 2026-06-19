/**
 * Unit tests for the /api/art-page client helper (src/lib/artPage.ts).
 * These run with vitest (already configured in the repo) without needing a real
 * server — fetch is mocked at the global level.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchArtPage } from './artPage';

// ─── helpers ─────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  const json = vi.fn().mockResolvedValue(body);
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('fetchArtPage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('calls the correct URL with encoded query and page number', async () => {
    const payload = { items: [], page: 2, hasMore: false, total: 0 };
    const fetchMock = mockFetch(payload);
    globalThis.fetch = fetchMock as typeof fetch;

    await fetchArtPage('van gogh', 2);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/art-page?q=van%20gogh&page=2');
    // No signal passed → init should have no signal (or undefined signal)
    expect((init as RequestInit | undefined)?.signal).toBeUndefined();
  });

  it('forwards the AbortSignal to fetch', async () => {
    const payload = { items: [], page: 1, hasMore: true, total: 500 };
    const fetchMock = mockFetch(payload);
    globalThis.fetch = fetchMock as typeof fetch;

    const ctrl = new AbortController();
    await fetchArtPage('monet', 1, ctrl.signal);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(ctrl.signal);
  });

  it('returns parsed JSON on a 200 response', async () => {
    const payload = {
      items: [{ id: 'aic:123', title: 'Water Lilies', artist: 'Monet' }],
      page: 1,
      hasMore: true,
      total: 1234,
    };
    globalThis.fetch = mockFetch(payload) as typeof fetch;

    const result = await fetchArtPage('monet', 1);

    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(1234);
    expect(result.page).toBe(1);
  });

  it('throws with the server error message on a non-OK response', async () => {
    globalThis.fetch = mockFetch({ error: 'Rate limited' }, 429) as typeof fetch;

    await expect(fetchArtPage('rembrandt', 3)).rejects.toThrow('Rate limited');
  });

  it('throws a generic HTTP message when the error body has no .error field', async () => {
    globalThis.fetch = mockFetch({}, 502) as typeof fetch;

    await expect(fetchArtPage('dali', 1)).rejects.toThrow('HTTP 502');
  });

  it('re-throws AbortError transparently', async () => {
    const abortError = new DOMException('The user aborted a request.', 'AbortError');
    globalThis.fetch = vi.fn().mockRejectedValue(abortError) as typeof fetch;

    const ctrl = new AbortController();
    ctrl.abort();
    // The abort propagates as a DOMException whose NAME is "AbortError" (its
    // message is the runtime-specific "The user aborted a request.").
    await expect(fetchArtPage('picasso', 1, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('URI-encodes special characters in the query', async () => {
    const payload = { items: [], page: 1, hasMore: false, total: 0 };
    const fetchMock = mockFetch(payload);
    globalThis.fetch = fetchMock as typeof fetch;

    await fetchArtPage('van gogh & sunflowers', 1);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toContain('van%20gogh%20%26%20sunflowers');
  });
});
