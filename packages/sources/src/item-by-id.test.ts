import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the by-id deep-link fallback: fetchItemById routes a stable item id to the
// right resolver (Commons API for commons-<pageid>, HF dump /filter by exact id for
// every other source) and maps the response to an ArtItem. timedFetch (undici) is
// mocked — no network. The router is what /api/item calls.

const { timedFetchMock } = vi.hoisted(() => ({ timedFetchMock: vi.fn() }));
vi.mock('./helpers.js', async (orig) => ({
  ...(await orig<typeof import('./helpers.js')>()),
  timedFetch: timedFetchMock,
}));

import { fetchItemById, fetchDumpItemById, fetchCommonsItemById } from './adapters.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, json: async () => ({}) };

// Route mock responses by URL so a single fetcher's multiple calls (filter + name
// index, or imageinfo + SDC) each get a sane shape.
function route(map: { dump?: unknown; commons?: unknown }) {
  timedFetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('datasets-server.huggingface.co')) return Promise.resolve(ok(map.dump ?? { rows: [] }));
    if (u.includes('commons.wikimedia.org')) return Promise.resolve(ok(map.commons ?? { query: { pages: {} } }));
    return Promise.resolve(ok({})); // name_to_qid index etc.
  });
}

beforeEach(() => timedFetchMock.mockReset());

const DUMP_ROW = {
  rows: [{ row: {
    id: 'aic-42', source: 'aic', title: 'A Sunday on La Grande Jatte', artist: 'Georges Seurat',
    image_thumb: 'http://art.test/t.jpg', image_full: 'http://art.test/f.jpg',
    wikidata_qid: 'Q12345', artist_qid: 'Q170348', is_public_domain: true,
  } }],
};

const COMMONS_PAGE = {
  query: { pages: { '777': {
    title: 'File:Demo.jpg',
    imageinfo: [{
      url: 'http://c.test/full.jpg', thumburl: 'http://c.test/thumb.jpg',
      width: 1000, height: 800, mime: 'image/jpeg',
      extmetadata: { LicenseShortName: { value: 'CC0' }, ObjectName: { value: 'painting' } },
    }],
  } } },
};

describe('fetchDumpItemById (exact id → ArtItem from the HF dump)', () => {
  it('resolves a dump row by its stored id, mapping the KG fields', async () => {
    route({ dump: DUMP_ROW });
    const it = await fetchDumpItemById('NullSense/harpe-art', 'aic-42');
    expect(it?.id).toBe('aic-42');
    expect(it?.source).toBe('aic');
    expect(it?.wikidataId).toBe('Q12345');
    expect(it?.artistId).toBe('Q170348');
    // the WHERE clause pins the exact id (no fan-out, length=1)
    const url = String(timedFetchMock.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toContain(`"id"='aic-42'`);
    expect(url).toContain('length=1');
  });
  it('rasterizes a Commons Special:FilePath preview so TIFFs render in the lightbox', async () => {
    // Wikidata dump rows store image_full as a raw Special:FilePath URL; for a .tif
    // that the browser cannot decode, the lightbox preview must go through ?width=
    // (which auto-rasterizes to JPEG). fullUrl stays raw for the download original.
    const fileBase = 'https://commons.wikimedia.org/wiki/Special:FilePath/Stan.tif';
    route({ dump: { rows: [{ row: {
      id: 'wd-Q6609268', source: 'wikidata', title: 'Stańczyk', artist: 'Jan Matejko',
      image_thumb: `${fileBase}?width=400`, image_full: fileBase, is_public_domain: true,
    } }] } });
    const it = await fetchDumpItemById('NullSense/harpe-art', 'wd-Q6609268');
    expect(it?.previewUrl).toBe(`${fileBase}?width=1600`); // renderable
    expect(it?.fullUrl).toBe(fileBase);                     // raw original for download
  });
  it('leaves a non-FilePath JPEG preview untouched', async () => {
    route({ dump: DUMP_ROW }); // image_full = http://art.test/f.jpg (https-upgraded, no ?width=)
    const it = await fetchDumpItemById('NullSense/harpe-art', 'aic-42');
    expect(it?.previewUrl).toBe('https://art.test/f.jpg');
  });
  it('returns null on a miss (no rows) or HTTP error', async () => {
    route({ dump: { rows: [] } });
    expect(await fetchDumpItemById('ds', 'aic-999')).toBeNull();
    timedFetchMock.mockResolvedValue(notFound);
    expect(await fetchDumpItemById('ds', 'aic-1')).toBeNull();
  });
  it('returns null for empty dataset or id (no upstream call)', async () => {
    expect(await fetchDumpItemById('', 'aic-1')).toBeNull();
    expect(await fetchDumpItemById('ds', '')).toBeNull();
    expect(timedFetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchCommonsItemById (pageid → ArtItem from the Commons API)', () => {
  it('resolves a Commons file by pageid via the by-pageids query', async () => {
    route({ commons: COMMONS_PAGE });
    const it = await fetchCommonsItemById('777');
    expect(it?.id).toBe('commons-777');
    expect(it?.source).toBe('commons');
    expect(it?.isPublicDomain).toBe(true);
    expect(it?.medium).toBe('painting'); // ObjectName extmetadata
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('pageids=777');
  });
  it('returns null when the page is absent', async () => {
    route({ commons: { query: { pages: {} } } });
    expect(await fetchCommonsItemById('404')).toBeNull();
  });
});

describe('fetchItemById (router by id prefix)', () => {
  it('routes commons-<n> to the Commons API', async () => {
    route({ commons: COMMONS_PAGE });
    const it = await fetchItemById('commons-777');
    expect(it?.source).toBe('commons');
    expect(timedFetchMock.mock.calls.every((c) => String(c[0]).includes('commons.wikimedia.org'))).toBe(true);
  });
  it('routes every other prefix to the HF dump by exact id', async () => {
    vi.stubEnv('HARPE_DUMP_DATASET', 'NullSense/harpe-art');
    route({ dump: DUMP_ROW });
    const it = await fetchItemById('aic-42');
    expect(it?.source).toBe('aic');
    expect(String(timedFetchMock.mock.calls[0][0])).toContain('datasets-server.huggingface.co');
    vi.unstubAllEnvs();
  });
});
