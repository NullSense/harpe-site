import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the knowledge-graph entity fetchers (static JSON on the HF CDN).
// timedFetch (undici) is mocked — no network. 404 → null (unknown entity, not an
// error); other non-2xx → throws (handled by dumpHttpPolicy/handler).

const { timedFetchMock } = vi.hoisted(() => ({ timedFetchMock: vi.fn() }));
vi.mock('./helpers.js', async (orig) => ({
  ...(await orig<typeof import('./helpers.js')>()),
  timedFetch: timedFetchMock,
}));

import { fetchArtistEntity, fetchArtistWorkIds, fetchSubjectEntity } from './adapters.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
beforeEach(() => timedFetchMock.mockReset());

describe('fetchArtistEntity', () => {
  it('returns the artist node and hits the right CDN path', async () => {
    timedFetchMock.mockResolvedValue(ok({ qid: 'Q41406', labelEn: 'Claude Monet', workCount: 312 }));
    const ent = await fetchArtistEntity('Q41406');
    expect(ent?.labelEn).toBe('Claude Monet');
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('/data/artists/Q41406.json');
  });
  it('returns null for an unknown artist (404)', async () => {
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchArtistEntity('Q999999999')).toBeNull();
  });
});

describe('fetchArtistWorkIds', () => {
  it('returns the id list', async () => {
    timedFetchMock.mockResolvedValue(ok(['wd-Q1', 'wd-Q2']));
    expect(await fetchArtistWorkIds('Q41406')).toEqual(['wd-Q1', 'wd-Q2']);
  });
  it('returns [] when missing (404) or malformed', async () => {
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchArtistWorkIds('Q1')).toEqual([]);
    timedFetchMock.mockResolvedValue(ok({ not: 'an array' }));
    expect(await fetchArtistWorkIds('Q1')).toEqual([]);
  });
});

describe('fetchSubjectEntity', () => {
  it('returns the subject node', async () => {
    timedFetchMock.mockResolvedValue(ok({ qid: 'Q146', labelEn: 'cat', workCount: 487 }));
    const ent = await fetchSubjectEntity('Q146');
    expect(ent?.labelEn).toBe('cat');
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('/data/depicts/Q146.json');
  });
});
