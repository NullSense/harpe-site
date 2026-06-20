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
  workTitleKey, enrichWorkIds, enrichArtistIds, _resetNameIndex,
  resolveQueryEntity, _resetSubjectIndex,
  fetchSuggestions, _resetSuggestCache,
} from './adapters.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
// Reset every memoised index so a prior test's mock can't leak (resolveQueryEntity
// now consults BOTH the subject and the name index).
beforeEach(() => { timedFetchMock.mockReset(); _resetEntityBucketCache(); _resetNameIndex(); _resetSubjectIndex(); });

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

describe('resolveQueryEntity (search → KG subject page)', () => {
  it('resolves a subject name to its QID (full name + surname suffix)', async () => {
    _resetSubjectIndex();
    timedFetchMock.mockResolvedValue(ok({ 'Joan of Arc': 'Q7226', 'Mount Vesuvius': 'Q149888' }));
    expect(await resolveQueryEntity('Joan of Arc')).toEqual({ kind: 'subject', qid: 'Q7226' });
    expect(await resolveQueryEntity('mount vesuvius')).toEqual({ kind: 'subject', qid: 'Q149888' });
  });
  it('returns null for an unknown query and for too-short input', async () => {
    _resetSubjectIndex();
    timedFetchMock.mockResolvedValue(ok({ 'Joan of Arc': 'Q7226' }));
    expect(await resolveQueryEntity('Nobody McNobody')).toBeNull();
    expect(await resolveQueryEntity('ab')).toBeNull(); // < 3 chars → no lookup
  });
  it('is a graceful no-op when the subject index is absent (404)', async () => {
    _resetSubjectIndex();
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await resolveQueryEntity('Joan of Arc')).toBeNull();
  });

  it('resolves a full-name ARTIST via the name index, but NOT a single token', async () => {
    _resetSubjectIndex(); _resetNameIndex();
    // route by URL: not a subject, but a known artist in the name index
    timedFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes('subject_to_qid')) return Promise.resolve(ok({}));
      if (u.includes('name_to_qid')) return Promise.resolve(ok({ 'Jan Matejko': 'Q189117' }));
      return Promise.resolve(ok({}));
    });
    expect(await resolveQueryEntity('Jan Matejko')).toEqual({ kind: 'artist', qid: 'Q189117' });
    // single token → no artist auto-nav (surnames collide with common words)
    expect(await resolveQueryEntity('matejko')).toBeNull();
  });

  it('prefers a SUBJECT match over an artist match', async () => {
    _resetSubjectIndex(); _resetNameIndex();
    timedFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes('subject_to_qid')) return Promise.resolve(ok({ 'Saint George': 'Q48438' }));
      if (u.includes('name_to_qid')) return Promise.resolve(ok({ 'Saint George': 'Q9999999' }));
      return Promise.resolve(ok({}));
    });
    expect(await resolveQueryEntity('Saint George')).toEqual({ kind: 'subject', qid: 'Q48438' });
  });
});

describe('fetchSuggestions (KG autocomplete pool)', () => {
  it('returns the suggest.json array and memoises it', async () => {
    _resetSuggestCache();
    const pool = [{ label: 'Jan Matejko', kind: 'artist', qid: 'Q189117', n: 186 }];
    timedFetchMock.mockResolvedValue(ok(pool));
    expect(await fetchSuggestions()).toEqual(pool);
    expect(await fetchSuggestions()).toEqual(pool); // cached
    expect(timedFetchMock).toHaveBeenCalledTimes(1);
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('/data/suggest.json');
  });
  it('returns [] when the pool is absent (404)', async () => {
    _resetSuggestCache();
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchSuggestions()).toEqual([]);
  });
});

describe('workTitleKey (MUST match enrich_entities.py `_work_title_key`)', () => {
  it('normalises titles byte-identically to the Python index builder', () => {
    expect(workTitleKey('The Great Wave off Kanagawa')).toBe('the great wave off kanagawa');
    expect(workTitleKey('Under the Wave off Kanagawa (Kanagawa oki nami ura)'))
      .toBe('under the wave off kanagawa kanagawa oki nami ura');
    expect(workTitleKey("Belshazzar's Feast")).toBe('belshazzar s feast');
    expect(workTitleKey('Café Terrace, Arles')).toBe('cafe terrace arles');
    expect(workTitleKey('神奈川沖浪裏')).toBe('神奈川沖浪裏'); // CJK preserved for JP aliases
  });
});

describe('enrichArtistIds (universal artist linking across ALL sources)', () => {
  it('links live-source items via name→QID; suffix-matches, is idempotent, skips no-artist', async () => {
    _resetNameIndex();
    timedFetchMock.mockResolvedValue(ok({ 'Claude Monet': 'Q41406', 'Vincent van Gogh': 'Q5582' }));
    const items = [
      { id: 'commons-1', source: 'commons', title: 'Water Lilies', artist: 'Claude Monet' }, // live → resolved
      { id: 'vam-1', source: 'vam', title: 'X', artist: 'van Gogh' },                          // ≥4-char surname
      { id: 'aic-9', source: 'aic', title: 'Y', artist: 'Nobody', artistId: 'Q1' },            // already linked → kept
      { id: 'met-3', source: 'met', title: 'Z' },                                              // no artist → skipped
    ];
    await enrichArtistIds(items as never);
    expect((items[0] as { artistId?: string }).artistId).toBe('Q41406');
    expect((items[1] as { artistId?: string }).artistId).toBe('Q5582');
    expect((items[2] as { artistId?: string }).artistId).toBe('Q1');        // not overwritten
    expect((items[3] as { artistId?: string }).artistId).toBeUndefined();   // no artist text
  });
  it('is a graceful no-op when the name index is unavailable (404)', async () => {
    _resetNameIndex();
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const items = [{ id: 'commons-2', source: 'commons', title: 'A', artist: 'Claude Monet' }];
    await enrichArtistIds(items as never);
    expect((items[0] as { artistId?: string }).artistId).toBeUndefined();
  });
});

describe('enrichWorkIds (work_index → wikidataId; the cross-title unifier)', () => {
  const aid = 'Q5599'; // Hokusai stand-in (bucket 223)
  const shard = {
    [`the great wave off kanagawa~${aid}`]: 'Q1782705',
    [`under the wave off kanagawa kanagawa oki nami ura~${aid}`]: 'Q1782705',
  };

  it('resolves DIFFERENT-titled copies of one work to the same QID', async () => {
    timedFetchMock.mockResolvedValue(ok(shard));
    const items = [
      { id: 'met-1', source: 'met', title: 'Under the Wave off Kanagawa (Kanagawa oki nami ura)', artist: 'Katsushika Hokusai', artistId: aid },
      { id: 'commons-1', source: 'commons', title: 'Hokusai - The Great Wave off Kanagawa - Google Art Project', artist: 'Katsushika Hokusai', artistId: aid },
    ];
    await enrichWorkIds(items as never);
    expect((items[0] as { wikidataId?: string }).wikidataId).toBe('Q1782705'); // clean museum title
    expect((items[1] as { wikidataId?: string }).wikidataId).toBe('Q1782705'); // artist-prefix + programme suffix stripped
  });

  it('is a graceful no-op when the shard is absent (pre-enrichment)', async () => {
    timedFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const items = [{ id: 'a', source: 'met', title: 'The Great Wave off Kanagawa', artist: 'Katsushika Hokusai', artistId: aid }];
    await enrichWorkIds(items as never);
    expect((items[0] as { wikidataId?: string }).wikidataId).toBeUndefined();
  });

  it('leaves items that already have a wikidataId or lack an artistId untouched', async () => {
    timedFetchMock.mockResolvedValue(ok(shard));
    const items = [
      { id: 'a', source: 'wikidata', title: 'The Great Wave off Kanagawa', artist: 'Hokusai', artistId: aid, wikidataId: 'Q9' },
      { id: 'b', source: 'met', title: 'The Great Wave off Kanagawa', artist: 'Hokusai' }, // no artistId
    ];
    await enrichWorkIds(items as never);
    expect((items[0] as { wikidataId?: string }).wikidataId).toBe('Q9'); // not overwritten
    expect((items[1] as { wikidataId?: string }).wikidataId).toBeUndefined(); // no artistId → skipped
  });
});
