import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanTitle, isReferencePage, isArtUrl, jsonldQuery, queryFromUrl } from './routing';

// Ported from harpe tests/test_routing.py.
describe('cleanTitle', () => {
  it('strips a trailing " | Site"', () => {
    expect(cleanTitle('‘Moses Breaketh the Tables’, John Martin, published 1833 | Tate'))
      .toBe('‘Moses Breaketh the Tables’, John Martin, published 1833');
  });

  it('strips a trailing " - Museum"', () => {
    expect(cleanTitle('The Night Watch - Rijksmuseum')).toBe('The Night Watch');
  });

  it('keeps "Title - Artist" (artist is not a museum keyword, no pipe)', () => {
    expect(cleanTitle('The Bedroom - Vincent van Gogh')).toBe('The Bedroom - Vincent van Gogh');
  });

  it('rejects bot-wall titles', () => {
    expect(cleanTitle('Just a moment...')).toBe('');
    expect(cleanTitle('Vercel Security Checkpoint')).toBe('');
  });

  it('decodes HTML entities', () => {
    expect(cleanTitle('Mother &amp; Child')).toBe('Mother & Child');
  });
});

describe('URL classification', () => {
  it('isReferencePage', () => {
    expect(isReferencePage('https://www.tate.org.uk/art/artworks/martin-x-t04895')).toBe(true);
    expect(isReferencePage('https://en.wikipedia.org/wiki/The_Deluge')).toBe(true);
    expect(isReferencePage('https://x.com/user/status/123')).toBe(false);
  });

  it('isArtUrl', () => {
    expect(isArtUrl('https://artsandculture.google.com/asset/x/y')).toBe(true);
    expect(isArtUrl('https://example.org/iiif/2/abc/manifest.json')).toBe(true);
    expect(isArtUrl('https://example.org/gallery')).toBe(false);
  });
});

// ─── jsonldQuery (ported from test_jsonld.py) ─────────────────────────────────

describe('jsonldQuery', () => {
  it('extracts name and creator from a Painting JSON-LD block', () => {
    const html = '<script type="application/ld+json">{"@type":"Painting","name":"The Night Watch","creator":{"@type":"Person","name":"Rembrandt"}}</script>';
    expect(jsonldQuery(html)).toBe('The Night Watch Rembrandt');
  });

  it('handles @graph nesting, array name, and author list', () => {
    const html = '<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"VisualArtwork","name":["Starry Night"],"author":[{"name":"van Gogh"}]}]}</script>';
    expect(jsonldQuery(html)).toBe('Starry Night van Gogh');
  });

  it('returns empty string if no artwork type is found', () => {
    const html = '<script type="application/ld+json">{"@type":"Organization","name":"Some Museum"}</script>';
    expect(jsonldQuery(html)).toBe('');
  });

  it('ignores malformed JSON', () => {
    const html = '<script type="application/ld+json">{not valid json,,,}</script>';
    expect(jsonldQuery(html)).toBe('');
  });

  it('returns just name when no creator/author present', () => {
    const html = '<script type="application/ld+json">{"@type":"Artwork","name":"Untitled"}</script>';
    expect(jsonldQuery(html)).toBe('Untitled');
  });
});

// ─── queryFromUrl (network, mocked) ───────────────────────────────────────────

describe('queryFromUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes Google Arts & Culture /asset/<slug> without network call', async () => {
    // ASSET_RE captures the first segment after /asset/ only
    const q = await queryFromUrl('https://artsandculture.google.com/asset/the-night-watch');
    expect(q).toBe('the night watch');
  });

  it('returns JSON-LD title when available', async () => {
    const html = '<script type="application/ld+json">{"@type":"Painting","name":"Girl with a Pearl Earring","creator":{"name":"Vermeer"}}</script>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      url: 'https://museum.test/painting',
      text: async () => html,
    }));
    const q = await queryFromUrl('https://museum.test/painting');
    expect(q).toBe('Girl with a Pearl Earring Vermeer');
  });

  it('falls back to og:title when no JSON-LD artwork', async () => {
    // "MoMA" is not in the SITE_TAIL keyword list; cleanTitle keeps the full title
    const html = '<meta property="og:title" content="The Starry Night | Museum of Modern Art">';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      url: 'https://moma.test/works/1',
      text: async () => html,
    }));
    const q = await queryFromUrl('https://moma.test/works/1');
    // PIPE_TAIL strips " | Museum of Modern Art"
    expect(q).toBe('The Starry Night');
  });

  it('falls back to <title> when no og:title', async () => {
    const html = '<html><head><title>Sunflowers | Van Gogh Museum</title></head></html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      url: 'https://vangoghmuseum.test/work/1',
      text: async () => html,
    }));
    const q = await queryFromUrl('https://vangoghmuseum.test/work/1');
    expect(q).toBe('Sunflowers');
  });

  it('returns empty string on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const q = await queryFromUrl('https://offline.test/work/1');
    expect(q).toBe('');
  });
});
