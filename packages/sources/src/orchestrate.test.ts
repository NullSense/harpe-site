import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtItem } from '@harpe/core';

// Guards the shared search/KG orchestration used identically by the Vercel handlers
// AND the MCP server. gatherSources + the entity/dump fetchers are mocked; the
// ranking pipeline (@harpe/core) is real, so dedup/relevance behaviour is exercised.

const m = vi.hoisted(() => ({
  gatherSources: vi.fn(),
  fetchArtistEntity: vi.fn(),
  fetchArtistWorkIds: vi.fn(),
  fetchSubjectEntity: vi.fn(),
  fetchDumpSearch: vi.fn(),
}));
vi.mock('./registry.js', async (orig) => ({ ...(await orig<typeof import('./registry.js')>()), gatherSources: m.gatherSources }));
vi.mock('./adapters.js', async (orig) => ({
  ...(await orig<typeof import('./adapters.js')>()),
  fetchArtistEntity: m.fetchArtistEntity,
  fetchArtistWorkIds: m.fetchArtistWorkIds,
  fetchSubjectEntity: m.fetchSubjectEntity,
  fetchDumpSearch: m.fetchDumpSearch,
}));

import { searchArt, loadArtistPage, loadSubjectPage } from './orchestrate.js';

function item(id: string, title: string, extra: Partial<ArtItem> = {}): ArtItem {
  return {
    id, title, artist: 'Claude Monet', dimensions: '',
    // distinct per-id URLs so dedup (image identity) doesn't fold them
    thumbUrl: `https://x/${id}-t.jpg`, previewUrl: `https://x/${id}-p.jpg`, fullUrl: `https://x/${id}-f.jpg`,
    format: 'jpeg', lossless: false, downloads: [], source: id.split('-')[0] as ArtItem['source'],
    isPublicDomain: true, ...extra,
  };
}

beforeEach(() => { for (const fn of Object.values(m)) fn.mockReset(); });

describe('searchArt', () => {
  it('collects fulfilled sources, ranks them, and turns a rejection into a warning', async () => {
    m.gatherSources.mockResolvedValue([
      ['aic', Promise.resolve([item('aic-1', 'Water Lilies')])],
      ['met', Promise.reject(new Error('down'))],
    ]);
    const { items, warnings } = await searchArt('water lilies');
    expect(items.map((i) => i.id)).toContain('aic-1');
    expect(warnings).toEqual(['met: down']);
  });

  it('honours the max cap', async () => {
    m.gatherSources.mockResolvedValue([
      // distinct titles so dedup keeps them all; the cap is what trims to 3
      ['aic', Promise.resolve(Array.from({ length: 10 }, (_, i) => item(`aic-${i}`, `Water Lilies ${i}`)))],
    ]);
    const { items } = await searchArt('water lilies', { max: 3 });
    expect(items.length).toBe(3);
  });

  it('returns partial results at the overall deadline instead of waiting on a hanging source', async () => {
    m.gatherSources.mockResolvedValue([
      ['aic', Promise.resolve([item('aic-1', 'Water Lilies')])],
      ['slow', new Promise(() => {})], // never resolves — must not hold the response
    ]);
    const t0 = Date.now();
    const { items, warnings } = await searchArt('water lilies', { deadlineMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2_000); // bounded, did not hang
    expect(items.map((i) => i.id)).toContain('aic-1'); // the fast source still made it
    expect(warnings.some((w) => /slow.*(deadline|timed out)/i.test(w))).toBe(true);
  });

  it('flags every source as timed out when all miss the deadline (so art.ts can still 502)', async () => {
    m.gatherSources.mockResolvedValue([
      ['aic', new Promise(() => {})],
      ['met', new Promise(() => {})],
    ]);
    const { items, warnings, sourceCount } = await searchArt('x', { deadlineMs: 30 });
    expect(items).toEqual([]);
    expect(warnings.length).toBe(sourceCount); // total timeout reads as total failure
  });
});

describe('loadArtistPage', () => {
  it('full QID search: federates ALL sources, attributed first, then broader name matches', async () => {
    m.fetchArtistEntity.mockResolvedValue({ qid: 'Q41406', labelEn: 'Claude Monet', workCount: 2 });
    m.fetchArtistWorkIds.mockResolvedValue(['wd-1']);
    m.gatherSources.mockResolvedValue([
      ['dump', Promise.resolve([
        item('aic-9', 'Houses of Parliament', { artistId: 'Q41406' }), // attributed via artistId
        item('wd-1', 'Water Lilies', { artistId: 'Q41406' }),          // attributed via idSet + artistId
        item('met-5', 'Some other study', { artistId: 'Q999' }),       // name match, NOT attributed
      ])],
    ]);
    const page = await loadArtistPage('Q41406', 'ds');
    expect(page?.attributedCount).toBe(2);
    const ids = page?.works.map((w) => w.id) ?? [];
    expect(ids.slice(0, 2).sort()).toEqual(['aic-9', 'wd-1']); // attributed section
    expect(ids.slice(2)).toEqual(['met-5']);                   // broader section
  });

  it('full QID search: a live Commons copy folds an attributed Wikidata work and wins the badge', async () => {
    m.fetchArtistEntity.mockResolvedValue({ qid: 'Q41406', labelEn: 'Claude Monet', workCount: 1 });
    m.fetchArtistWorkIds.mockResolvedValue(['wd-1']);
    m.gatherSources.mockResolvedValue([
      ['wikidata', Promise.resolve([item('wd-1', 'Water Lilies', { artistId: 'Q41406', wikidataId: 'Q111', width: 0, height: 0 })])],
      ['commons', Promise.resolve([item('commons-2', 'Water Lilies', { artistId: 'Q41406', wikidataId: 'Q111', width: 4000, height: 3000 })])],
    ]);
    const page = await loadArtistPage('Q41406', 'ds');
    expect(page?.works).toHaveLength(1);           // the two copies fold into one
    expect(page?.works[0].source).toBe('commons'); // live institutional-ish rep wins on area
    expect(page?.attributedCount).toBe(1);         // still attributed (folded id ∈ KG work set)
  });

  it('is null when the QID is not in the index (and never searches)', async () => {
    m.fetchArtistEntity.mockResolvedValue(null);
    m.fetchArtistWorkIds.mockResolvedValue([]);
    expect(await loadArtistPage('Q999', 'ds')).toBeNull();
    expect(m.gatherSources).not.toHaveBeenCalled();
  });

  it('still renders the entity (works: []) when the search hangs past the deadline', async () => {
    m.fetchArtistEntity.mockResolvedValue({ qid: 'Q41406', labelEn: 'Claude Monet', workCount: 2 });
    m.fetchArtistWorkIds.mockResolvedValue(['wd-1']);
    m.gatherSources.mockResolvedValue([['slow', new Promise(() => {})]]); // never resolves
    const t0 = Date.now();
    const page = await loadArtistPage('Q41406', 'ds', { deadlineMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(page?.entity.labelEn).toBe('Claude Monet');
    expect(page?.works).toEqual([]);
  });
});

describe('loadSubjectPage', () => {
  it('returns the entity + works whose depicts includes the QID', async () => {
    m.fetchSubjectEntity.mockResolvedValue({ qid: 'Q7569', labelEn: 'child', workCount: 1 });
    m.fetchDumpSearch.mockResolvedValue([
      item('aic-1', 'A child', { depicts: ['Q7569'] }),
      item('aic-2', 'No child', { depicts: ['Q99'] }),
    ]);
    const page = await loadSubjectPage('Q7569', 'ds');
    expect(page?.works.map((w) => w.id)).toEqual(['aic-1']);
  });

  it('full QID search: dedupes depicting works so the institutional copy wins (not Wikidata)', async () => {
    m.fetchSubjectEntity.mockResolvedValue({ qid: 'Q7569', labelEn: 'child', workCount: 1 });
    m.fetchDumpSearch.mockResolvedValue([
      item('wd-1', 'Madonna', { depicts: ['Q7569'], wikidataId: 'Q500', width: 0, height: 0 }),
      item('aic-2', 'Madonna', { depicts: ['Q7569'], wikidataId: 'Q500', width: 4000, height: 3000 }),
    ]);
    const page = await loadSubjectPage('Q7569', 'ds');
    expect(page?.works).toHaveLength(1);        // the two copies fold
    expect(page?.works[0].source).toBe('aic');  // institutional rep wins on area
  });

  it('keeps a depicting work whose title does not textually match the label', async () => {
    // attribution is by depicts QID, not text — dedupe must not relevance-filter it out
    m.fetchSubjectEntity.mockResolvedValue({ qid: 'Q7569', labelEn: 'child', workCount: 1 });
    m.fetchDumpSearch.mockResolvedValue([item('aic-1', 'The Madonna of the Rocks', { depicts: ['Q7569'] })]);
    const page = await loadSubjectPage('Q7569', 'ds');
    expect(page?.works.map((w) => w.id)).toEqual(['aic-1']);
  });

  it('is null for an unknown subject', async () => {
    m.fetchSubjectEntity.mockResolvedValue(null);
    expect(await loadSubjectPage('Q999', 'ds')).toBeNull();
  });

  it('still renders the entity (works: []) when the dump hangs past the deadline', async () => {
    m.fetchSubjectEntity.mockResolvedValue({ qid: 'Q7569', labelEn: 'child', workCount: 1 });
    m.fetchDumpSearch.mockReturnValue(new Promise(() => {})); // never resolves
    const t0 = Date.now();
    const page = await loadSubjectPage('Q7569', 'ds', { deadlineMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(page?.entity.labelEn).toBe('child');
    expect(page?.works).toEqual([]);
  });
});
