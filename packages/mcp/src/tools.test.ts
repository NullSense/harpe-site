import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtItem } from '@harpe/core';

// The engine (@harpe/sources) is mocked — these test the MCP tool layer only:
// the slim() projection, the not-found shaping, and that registerTools wires all
// five tools with input schemas.
const m = vi.hoisted(() => ({
  searchArt: vi.fn(),
  loadArtistPage: vi.fn(),
  loadSubjectPage: vi.fn(),
  resolveQueryEntity: vi.fn(),
  fetchItemById: vi.fn(),
}));
vi.mock('@harpe/sources', () => m);

import { searchArtTool, artistTool, subjectTool, resolveTool, itemTool, registerTools } from './tools.js';

const parse = (r: { content: { type: 'text'; text: string }[] }) => JSON.parse(r.content[0].text);

function item(id: string, extra: Partial<ArtItem> = {}): ArtItem {
  return {
    id, title: 'Water Lilies', artist: 'Claude Monet', dimensions: '',
    thumbUrl: `https://x/${id}-t.jpg`, previewUrl: `https://x/${id}-p.jpg`, fullUrl: `https://x/${id}-f.jpg`,
    format: 'jpeg', lossless: false,
    downloads: [{ label: 'JPEG', url: 'https://x/f.jpg', format: 'jpeg', lossless: false }],
    source: id.split('-')[0] as ArtItem['source'], isPublicDomain: true, ...extra,
  };
}

beforeEach(() => { for (const fn of Object.values(m)) fn.mockReset(); });

describe('searchArtTool', () => {
  it('returns slimmed items (no download blobs) + count + warnings', async () => {
    m.searchArt.mockResolvedValue({ items: [item('met-1', { wikidataId: 'Q1', artistId: 'Q5' })], warnings: ['aic: down'], sourceCount: 2 });
    const out = parse(await searchArtTool({ query: 'monet' }));
    expect(out.count).toBe(1);
    expect(out.items[0]).toMatchObject({ id: 'met-1', title: 'Water Lilies', wikidataId: 'Q1', artistId: 'Q5', image: 'https://x/met-1-f.jpg' });
    expect(out.items[0]).not.toHaveProperty('downloads'); // slimmed away
    expect(out.warnings).toEqual(['aic: down']);
  });
  it('passes the max cap through to the engine', async () => {
    m.searchArt.mockResolvedValue({ items: [], warnings: [], sourceCount: 1 });
    await searchArtTool({ query: 'monet', max: 5 });
    expect(m.searchArt).toHaveBeenCalledWith('monet', { max: 5 });
  });
});

describe('artist / subject tools', () => {
  it('artistTool returns the entity + slimmed works', async () => {
    m.loadArtistPage.mockResolvedValue({ entity: { qid: 'Q41406', labelEn: 'Claude Monet', workCount: 1 }, works: [item('met-1')] });
    const out = parse(await artistTool({ qid: 'Q41406' }));
    expect(out.entity.labelEn).toBe('Claude Monet');
    expect(out.works[0].id).toBe('met-1');
  });
  it('artistTool reports a not-in-graph QID as an error payload', async () => {
    m.loadArtistPage.mockResolvedValue(null);
    expect(parse(await artistTool({ qid: 'Q999' })).error).toMatch(/Q999/);
  });
  it('subjectTool returns works for a known subject', async () => {
    m.loadSubjectPage.mockResolvedValue({ entity: { qid: 'Q7569', labelEn: 'child', workCount: 1 }, works: [item('aic-2')] });
    expect(parse(await subjectTool({ qid: 'Q7569' })).works[0].id).toBe('aic-2');
  });
});

describe('resolve / item tools', () => {
  it('resolveTool surfaces the detected subject entity (or null)', async () => {
    m.resolveQueryEntity.mockResolvedValue({ kind: 'subject', qid: 'Q7569' });
    expect(parse(await resolveTool({ query: 'joan of arc' })).entity).toEqual({ kind: 'subject', qid: 'Q7569' });
    m.resolveQueryEntity.mockResolvedValue(null);
    expect(parse(await resolveTool({ query: 'nobody' })).entity).toBeNull();
  });
  it('itemTool resolves a known id and errors on a miss', async () => {
    m.fetchItemById.mockResolvedValue(item('commons-5'));
    expect(parse(await itemTool({ id: 'commons-5' })).item.id).toBe('commons-5');
    m.fetchItemById.mockResolvedValue(null);
    expect(parse(await itemTool({ id: 'x-0' })).error).toMatch(/not found/);
  });
});

describe('registerTools', () => {
  it('registers all five tools, each with a description + input schema', () => {
    const registerTool = vi.fn();
    registerTools({ registerTool } as never);
    const names = registerTool.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['search_art', 'artist', 'subject', 'resolve', 'item']);
    for (const [, config, cb] of registerTool.mock.calls) {
      expect(config.description).toBeTruthy();
      expect(config.inputSchema).toBeTruthy();
      expect(typeof cb).toBe('function');
    }
  });
});
