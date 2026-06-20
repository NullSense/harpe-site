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
});

describe('loadArtistPage', () => {
  it('returns the entity + only its known works from the dump', async () => {
    m.fetchArtistEntity.mockResolvedValue({ qid: 'Q41406', labelEn: 'Claude Monet', workCount: 2 });
    m.fetchArtistWorkIds.mockResolvedValue(['aic-1', 'met-9']);
    m.fetchDumpSearch.mockResolvedValue([item('aic-1', 'Water Lilies'), item('zzz-2', 'Unrelated')]);
    const page = await loadArtistPage('Q41406', 'ds');
    expect(page?.entity.labelEn).toBe('Claude Monet');
    expect(page?.works.map((w) => w.id)).toEqual(['aic-1']); // zzz-2 not in the work-id set
  });

  it('is null when the QID is not in the index (and never hits the dump)', async () => {
    m.fetchArtistEntity.mockResolvedValue(null);
    m.fetchArtistWorkIds.mockResolvedValue([]);
    expect(await loadArtistPage('Q999', 'ds')).toBeNull();
    expect(m.fetchDumpSearch).not.toHaveBeenCalled();
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

  it('is null for an unknown subject', async () => {
    m.fetchSubjectEntity.mockResolvedValue(null);
    expect(await loadSubjectPage('Q999', 'ds')).toBeNull();
  });
});
