/**
 * Tests for sources.ts — ported from harpe/tests/test_sources.py (expanded).
 * All sources use mocked fetch; no live network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candidate } from './models.js';

// ---------------------------------------------------------------------------
// Helpers to build minimal API response fixtures
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

function mockFetch(responses: Map<string, JsonBody | Array<JsonBody>>) {
  // Tracks call index per URL pattern for multi-call sources (Met)
  const callCount = new Map<string, number>();
  return vi.fn((url: string | URL | Request, _init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
    // Find matching response by prefix
    let body: JsonBody | Array<JsonBody> | undefined;
    let matchedKey = '';
    for (const [key, val] of responses) {
      if (u.includes(key) && key.length > matchedKey.length) {
        body = val;
        matchedKey = key;
      }
    }
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    // If array, return responses in order (for Met two-phase)
    let resolved: JsonBody;
    if (Array.isArray(body)) {
      const idx = callCount.get(matchedKey) ?? 0;
      resolved = body[idx] ?? body[body.length - 1];
      callCount.set(matchedKey, idx + 1);
    } else {
      resolved = body;
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(resolved),
    });
  });
}

// ---------------------------------------------------------------------------
// Helper to extract internal source functions via re-import after vi.stubGlobal
// ---------------------------------------------------------------------------

// We test gather() which calls all sources; we also test each adapter by checking
// that gather() with a single-source mock returns the expected candidate shape.
// Since sources.ts uses module-level fetch (global), we stub globalThis.fetch.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Commons adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps a Commons imageinfo page to a Candidate', async () => {
    const fixture: JsonBody = {
      query: {
        pages: {
          '123': {
            title: 'File:Sunset.jpg',
            imageinfo: [{ url: 'https://upload.wikimedia.org/sunset.jpg', thumburl: 'https://upload.wikimedia.org/thumb/sunset.jpg', width: 4000, height: 3000, mime: 'image/jpeg' }],
          },
        },
      },
    };
    const responses = new Map<string, JsonBody>([
      ['commons.wikimedia.org', fixture],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=commons-' + Date.now());
    const cands: Candidate[] = await gather('sunset');

    const c = cands.find((x) => x.source === 'Commons');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://upload.wikimedia.org/sunset.jpg');
    expect(c!.thumb).toBe('https://upload.wikimedia.org/thumb/sunset.jpg');
    expect(c!.title).toBe('Sunset');
    expect(c!.area).toBe(4000 * 3000);
    expect(c!.res).toBe('4000x3000');
  });

  it('skips non-image MIME types', async () => {
    const fixture: JsonBody = {
      query: {
        pages: {
          '456': {
            title: 'File:Video.ogv',
            imageinfo: [{ url: 'https://upload.wikimedia.org/video.ogv', width: 1920, height: 1080, mime: 'video/ogg' }],
          },
        },
      },
    };
    const responses = new Map<string, JsonBody>([
      ['commons.wikimedia.org', fixture],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=commons-skip-' + Date.now());
    const cands: Candidate[] = await gather('video');
    expect(cands.filter((c) => c.source === 'Commons')).toHaveLength(0);
  });
});

describe('AIC adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps an AIC artwork to Candidate with correct IIIF URL', async () => {
    const fixture: JsonBody = {
      config: { iiif_url: 'https://www.artic.edu/iiif/2' },
      data: [{
        id: 1, title: 'A Sunday Afternoon', artist_title: 'Seurat',
        date_display: '1886', medium_display: 'Oil on canvas',
        description: '<p>Pointillist masterpiece</p>', dimensions: '207.5 × 308.1 cm; framed',
        image_id: 'abc123', is_public_domain: true,
        thumbnail: { width: 843, height: 600 },
      }],
    };
    const responses = new Map<string, JsonBody>([
      ['artic.edu', fixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=aic-' + Date.now());
    const cands: Candidate[] = await gather('sunday seurat');
    const c = cands.find((x) => x.source === 'AIC');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://www.artic.edu/iiif/2/abc123/full/full/0/default.jpg');
    expect(c!.thumb).toBe('https://www.artic.edu/iiif/2/abc123/full/400,/0/default.jpg');
    expect(c!.title).toBe('A Sunday Afternoon');
    expect(c!.artist).toBe('Seurat');
    expect(c!.date).toBe('1886');
    expect(c!.area).toBe(843 * 600);
    expect(c!.desc).toBe('Pointillist masterpiece');
    expect(c!.physdim).toBe('207.5 × 308.1 cm');
  });

  it('skips non-public-domain artworks', async () => {
    const fixture: JsonBody = {
      config: {},
      data: [{ id: 2, title: 'Private Work', image_id: 'xxx', is_public_domain: false }],
    };
    const responses = new Map<string, JsonBody>([
      ['artic.edu', fixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=aic-skip-' + Date.now());
    const cands: Candidate[] = await gather('private');
    expect(cands.filter((c) => c.source === 'AIC')).toHaveLength(0);
  });
});

describe('Cleveland adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps a Cleveland artwork, handles string dimensions', async () => {
    const fixture: JsonBody = {
      data: [{
        title: 'Starry Night', creation_date: '1889', technique: 'Oil on canvas',
        description: '<b>Famous</b> work', measurements: '73.7 × 92.1 cm',
        creators: [{ description: 'Vincent van Gogh' }],
        images: {
          full: { url: 'https://openaccess-api.clevelandart.org/full.jpg', width: '4000', height: '3200' },
          web: { url: 'https://openaccess-api.clevelandart.org/web.jpg' },
        },
      }],
    };
    const responses = new Map<string, JsonBody>([
      ['clevelandart.org', fixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=cleveland-' + Date.now());
    const cands: Candidate[] = await gather('starry night');
    const c = cands.find((x) => x.source === 'Cleveland');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://openaccess-api.clevelandart.org/full.jpg');
    expect(c!.area).toBe(4000 * 3200);
    expect(c!.artist).toBe('Vincent van Gogh');
    expect(c!.desc).toBe('Famous work');
    expect(c!.physdim).toBe('73.7 × 92.1 cm');
  });
});

describe('Met adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps Met two-phase search→object to Candidate', async () => {
    const searchFixture: JsonBody = { objectIDs: [12345] };
    const objectFixture: JsonBody = {
      isPublicDomain: true,
      primaryImage: 'https://images.metmuseum.org/full.jpg',
      primaryImageSmall: 'https://images.metmuseum.org/small.jpg',
      title: 'The Death of Socrates', artistDisplayName: 'Jacques-Louis David',
      objectDate: '1787', medium: 'Oil on canvas',
      dimensions: '129.5 × 196.2 cm  (51 × 77 1/4 in.)',
    };
    const responses = new Map<string, JsonBody | Array<JsonBody>>([
      ['metmuseum.org/public/collection/v1/search', searchFixture],
      ['metmuseum.org/public/collection/v1/objects', objectFixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=met-' + Date.now());
    const cands: Candidate[] = await gather('socrates');
    const c = cands.find((x) => x.source === 'Met');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://images.metmuseum.org/full.jpg');
    expect(c!.thumb).toBe('https://images.metmuseum.org/small.jpg');
    expect(c!.area).toBe(30_000_000);
    expect(c!.title).toBe('The Death of Socrates');
    expect(c!.artist).toBe('Jacques-Louis David');
  });

  it('skips non-public-domain Met objects', async () => {
    const searchFixture: JsonBody = { objectIDs: [99999] };
    const objectFixture: JsonBody = { isPublicDomain: false, primaryImage: 'https://images.metmuseum.org/x.jpg' };
    const responses = new Map<string, JsonBody>([
      ['metmuseum.org/public/collection/v1/search', searchFixture],
      ['metmuseum.org/public/collection/v1/objects', objectFixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=met-skip-' + Date.now());
    const cands: Candidate[] = await gather('private');
    expect(cands.filter((c) => c.source === 'Met')).toHaveLength(0);
  });
});

describe('V&A adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps a V&A record to Candidate with framemark URL', async () => {
    const fixture: JsonBody = {
      records: [{
        _primaryImageId: 'O1234567',
        _primaryTitle: 'Sampler',
        _primaryMaker: { name: 'Mary Smith' },
        _primaryDate: '1820',
      }],
    };
    const responses = new Map<string, JsonBody>([
      ['api.vam.ac.uk', fixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=vam-' + Date.now());
    const cands: Candidate[] = await gather('sampler');
    const c = cands.find((x) => x.source === 'V&A');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://framemark.vam.ac.uk/collections/O1234567/full/full/0/default.jpg');
    expect(c!.thumb).toBe('https://framemark.vam.ac.uk/collections/O1234567/full/!400,400/0/default.jpg');
    expect(c!.title).toBe('Sampler');
    expect(c!.artist).toBe('Mary Smith');
    expect(c!.area).toBe(30_000_000);
  });
});

describe('Wikidata adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps wbsearchentities → SPARQL IIIF manifest to Candidate', async () => {
    const searchFixture: JsonBody = { search: [{ id: 'Q12345' }] };
    const sparqlFixture: JsonBody = {
      results: {
        bindings: [{
          itemLabel: { value: 'Girl with a Pearl Earring' },
          manifest: { value: 'https://iiif.example.com/manifest.json' },
        }],
      },
    };
    const responses = new Map<string, JsonBody>([
      ['wikidata.org/w', searchFixture],
      ['query.wikidata.org', sparqlFixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=wd-' + Date.now());
    const cands: Candidate[] = await gather('pearl earring');
    const c = cands.find((x) => x.source === 'Wikidata');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('iiif:https://iiif.example.com/manifest.json');
    expect(c!.title).toBe('Girl with a Pearl Earring');
    expect(c!.area).toBe(999_999_999);
    expect(c!.res).toBe('IIIF·max');
  });

  it('returns empty when no wikidata entities match', async () => {
    const responses = new Map<string, JsonBody>([
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=wd-empty-' + Date.now());
    const cands: Candidate[] = await gather('xyzzy');
    expect(cands.filter((c) => c.source === 'Wikidata')).toHaveLength(0);
  });
});

describe('Keyed sources return [] without API key', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // Ensure env keys are unset
    delete process.env.HARVARD_API_KEY;
    delete process.env.SMITHSONIAN_API_KEY;
    delete process.env.EUROPEANA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Harvard returns [] without HARVARD_API_KEY', async () => {
    const mockFn = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ records: [{ primaryimageurl: 'http://x.jpg', title: 'Test' }] }) }));
    vi.stubGlobal('fetch', mockFn);

    const { gather } = await import('./sources.js?v=harvard-nokey-' + Date.now());
    // Stub all other sources to return empty
    const empty: JsonBody = {};
    const responses = new Map<string, JsonBody>([
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const cands: Candidate[] = await gather('test');
    expect(cands.filter((c) => c.source === 'Harvard')).toHaveLength(0);
    // Harvard fetch should not have been called (no key = early return)
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    expect(calls.some(([u]) => u.includes('harvardartmuseums'))).toBe(false);
  });

  it('Smithsonian returns [] without SMITHSONIAN_API_KEY', async () => {
    const responses = new Map<string, JsonBody>([
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=si-nokey-' + Date.now());
    const cands: Candidate[] = await gather('test');
    expect(cands.filter((c) => c.source === 'Smithsonian')).toHaveLength(0);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    expect(calls.some(([u]) => u.includes('api.si.edu'))).toBe(false);
  });

  it('Europeana returns [] without EUROPEANA_API_KEY', async () => {
    const responses = new Map<string, JsonBody>([
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=eu-nokey-' + Date.now());
    const cands: Candidate[] = await gather('test');
    expect(cands.filter((c) => c.source === 'Europeana')).toHaveLength(0);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    expect(calls.some(([u]) => u.includes('europeana.eu'))).toBe(false);
  });

  it('Firecrawl returns [] without FIRECRAWL_API_KEY', async () => {
    const responses = new Map<string, JsonBody>([
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=fc-nokey-' + Date.now());
    const cands: Candidate[] = await gather('test');
    expect(cands.filter((c) => c.source === 'Web')).toHaveLength(0);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    expect(calls.some(([u]) => u.includes('firecrawl.dev'))).toBe(false);
  });
});

describe('Harvard adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); process.env.HARVARD_API_KEY = 'test-key'; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.HARVARD_API_KEY; });

  it('maps a Harvard record to Candidate', async () => {
    const fixture: JsonBody = {
      records: [{
        title: 'Portrait of a Man',
        people: [{ role: 'Artist', name: 'Rembrandt' }],
        primaryimageurl: 'https://nrs.harvard.edu/full.jpg',
        images: [{ width: 3000, height: 2400 }],
        dated: '1650',
      }],
    };
    const responses = new Map<string, JsonBody>([
      ['harvardartmuseums.org', fixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=harvard-' + Date.now());
    const cands: Candidate[] = await gather('rembrandt');
    const c = cands.find((x) => x.source === 'Harvard');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://nrs.harvard.edu/full.jpg');
    expect(c!.artist).toBe('Rembrandt');
    expect(c!.area).toBe(3000 * 2400);
    expect(c!.res).toBe('3000x2400');
    expect(c!.date).toBe('1650');
  });
});

describe('Smithsonian adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); process.env.SMITHSONIAN_API_KEY = 'test-key'; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SMITHSONIAN_API_KEY; });

  it('maps a Smithsonian record to Candidate', async () => {
    const fixture: JsonBody = {
      response: {
        rows: [{
          title: 'American Flag',
          content: {
            freetext: {
              name: [{ content: 'Unknown Artist' }],
              date: [{ content: '1776' }],
            },
            descriptiveNonRepeating: {
              online_media: {
                media: [{ content: 'https://ids.si.edu/ids/full.jpg', thumbnail: 'https://ids.si.edu/ids/thumb.jpg' }],
              },
            },
          },
        }],
      },
    };
    const responses = new Map<string, JsonBody>([
      ['api.si.edu', fixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['europeana.eu', { items: [] }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=si-' + Date.now());
    const cands: Candidate[] = await gather('flag');
    const c = cands.find((x) => x.source === 'Smithsonian');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://ids.si.edu/ids/full.jpg');
    expect(c!.thumb).toBe('https://ids.si.edu/ids/thumb.jpg');
    expect(c!.title).toBe('American Flag');
    expect(c!.artist).toBe('Unknown Artist');
    expect(c!.date).toBe('1776');
    expect(c!.area).toBe(30_000_000);
  });
});

describe('Europeana adapter', () => {
  beforeEach(() => { vi.unstubAllGlobals(); process.env.EUROPEANA_API_KEY = 'test-key'; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.EUROPEANA_API_KEY; });

  it('maps a Europeana item to Candidate', async () => {
    const fixture: JsonBody = {
      items: [{
        title: ['Night Watch'],
        dcCreator: ['Rembrandt van Rijn'],
        year: ['1642'],
        edmIsShownBy: ['https://iiif.europeana.eu/full.jpg'],
        edmPreview: ['https://iiif.europeana.eu/thumb.jpg'],
      }],
    };
    const responses = new Map<string, JsonBody>([
      ['europeana.eu', fixture],
      ['commons.wikimedia.org', { query: { pages: {} } }],
      ['wikidata.org/w', { search: [] }],
      ['query.wikidata.org', { results: { bindings: [] } }],
      ['artic.edu', { data: [], config: {} }],
      ['clevelandart.org', { data: [] }],
      ['metmuseum.org/public/collection/v1/search', { objectIDs: [] }],
      ['api.vam.ac.uk', { records: [] }],
      ['api.si.edu', { response: { rows: [] } }],
      ['firecrawl.dev', { data: { images: [] } }],
    ]);
    vi.stubGlobal('fetch', mockFetch(responses));

    const { gather } = await import('./sources.js?v=eu-' + Date.now());
    const cands: Candidate[] = await gather('night watch');
    const c = cands.find((x) => x.source === 'Europeana');
    expect(c).toBeDefined();
    expect(c!.spec).toBe('url:https://iiif.europeana.eu/full.jpg');
    expect(c!.thumb).toBe('https://iiif.europeana.eu/thumb.jpg');
    expect(c!.title).toBe('Night Watch');
    expect(c!.artist).toBe('Rembrandt van Rijn');
    expect(c!.date).toBe('1642');
  });
});

describe('gather error resilience', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a failing source does not block other sources', async () => {
    let callCount = 0;
    const mockFn = vi.fn((url: string | URL | Request) => {
      callCount++;
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      // Let AIC succeed, fail everything else
      if (u.includes('artic.edu')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            config: { iiif_url: 'https://www.artic.edu/iiif/2' },
            data: [{
              id: 1, title: 'Test', artist_title: 'Artist', date_display: '1900',
              image_id: 'img1', is_public_domain: true, thumbnail: { width: 100, height: 100 },
            }],
          }),
        });
      }
      // Fail all other sources
      return Promise.reject(new Error('network error'));
    });
    vi.stubGlobal('fetch', mockFn);

    const { gather } = await import('./sources.js?v=resilience-' + Date.now());
    const cands: Candidate[] = await gather('test');
    // Should still get AIC results despite other sources failing
    expect(cands.filter((c) => c.source === 'AIC')).toHaveLength(1);
  });
});
