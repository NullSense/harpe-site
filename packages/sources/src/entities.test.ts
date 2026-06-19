import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the knowledge-graph entity fetchers (static JSON on the HF CDN).
// Entities are SHARDED into bucket bundles ({QID: entity} per file): the fetcher
// downloads data/<dir>/<bucket>.json and indexes the QID out of it. timedFetch
// (undici) is mocked — no network. 404 → null (unknown entity, not an error).

const { timedFetchMock } = vi.hoisted(() => ({ timedFetchMock: vi.fn() }));
vi.mock('./helpers.js', async (orig) => ({
  ...(await orig<typeof import('./helpers.js')>()),
  timedFetch: timedFetchMock,
}));

import {
  fetchArtistEntity, fetchArtistWorkIds, fetchSubjectEntity,
  entityBucket, ENTITY_SHARDS, _resetEntityBucketCache,
} from './adapters.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
beforeEach(() => { timedFetchMock.mockReset(); _resetEntityBucketCache(); });

describe('entityBucket (MUST match enrich_entities.py `_bucket`: int(digits) % 256)', () => {
  it('shards QIDs by numeric remainder', () => {
    expect(ENTITY_SHARDS).toBe(256);
    expect(entityBucket('Q5')).toBe(5);
    expect(entityBucket('Q146')).toBe(146);
    expect(entityBucket('Q41406')).toBe(190);
    expect(entityBucket('Q1144558')).toBe(238);
    expect(entityBucket('Q119007077')).toBe(101);
  });
});

describe('fetchArtistEntity', () => {
  it('returns the artist node from its shard bundle, at the right CDN path', async () => {
    timedFetchMock.mockResolvedValue(ok({ Q41406: { qid: 'Q41406', labelEn: 'Claude Monet', workCount: 312 } }));
    const ent = await fetchArtistEntity('Q41406');
    expect(ent?.labelEn).toBe('Claude Monet');
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('/data/artists/190.json');
  });
  it('returns null when the QID is absent from its (present) shard', async () => {
    timedFetchMock.mockResolvedValue(ok({ Q41406: { qid: 'Q41406', labelEn: 'Monet', workCount: 1 } }));
    expect(await fetchArtistEntity('Q999999999')).toBeNull();
  });
  it('returns null for a missing shard (404)', async () => {
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchArtistEntity('Q888888')).toBeNull();
  });
});

describe('fetchArtistWorkIds', () => {
  it('returns the id list for the QID', async () => {
    timedFetchMock.mockResolvedValue(ok({ Q41406: ['wd-Q1', 'wd-Q2'] }));
    expect(await fetchArtistWorkIds('Q41406')).toEqual(['wd-Q1', 'wd-Q2']);
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('/data/work_ids_by_artist/190.json');
  });
  it('returns [] when the shard is missing (404)', async () => {
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchArtistWorkIds('Q1')).toEqual([]);
  });
  it('returns [] when the QID is absent or malformed', async () => {
    timedFetchMock.mockResolvedValue(ok({ Q2: { not: 'an array' } }));
    expect(await fetchArtistWorkIds('Q2')).toEqual([]);
  });
});

describe('fetchSubjectEntity', () => {
  it('returns the subject node from its shard bundle', async () => {
    timedFetchMock.mockResolvedValue(ok({ Q146: { qid: 'Q146', labelEn: 'cat', workCount: 487 } }));
    const ent = await fetchSubjectEntity('Q146');
    expect(ent?.labelEn).toBe('cat');
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('/data/depicts/146.json');
  });
});

describe('bucket memo', () => {
  it('fetches a shard once for multiple QIDs in the same bucket', async () => {
    // Q41406 and Q41662 are both 190 mod 256 → one download serves both.
    expect(entityBucket('Q41662')).toBe(190);
    timedFetchMock.mockResolvedValue(ok({
      Q41406: { qid: 'Q41406', labelEn: 'Monet', workCount: 1 },
      Q41662: { qid: 'Q41662', labelEn: 'Renoir', workCount: 1 },
    }));
    expect((await fetchArtistEntity('Q41406'))?.labelEn).toBe('Monet');
    expect((await fetchArtistEntity('Q41662'))?.labelEn).toBe('Renoir');
    expect(timedFetchMock).toHaveBeenCalledTimes(1);
  });
});
