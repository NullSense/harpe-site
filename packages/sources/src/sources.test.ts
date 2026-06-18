import { describe, it, expect } from 'vitest';
import { SOURCE_KEYS, validateArtItem, type ArtItem } from '@harpe/core';
import { SOURCES, activeSources, mapPool } from './registry.js';

// Guards the source registry + the unified-shape validator. Deterministic (no
// network) — the live per-source checks live in sources.live.test.ts.

function makeItem(over: Partial<ArtItem> = {}): ArtItem {
  return {
    id: 'aic-1', title: 'Water Lilies', artist: 'Claude Monet', dimensions: '',
    thumbUrl: 'https://x/t.jpg', previewUrl: 'https://x/p.jpg', fullUrl: 'https://x/f.jpg',
    format: 'jpeg', lossless: false, downloads: [], source: 'aic', isPublicDomain: true,
    ...over,
  };
}

describe('SOURCES registry', () => {
  it('every adapter has a key, label and fetch fn', () => {
    for (const s of SOURCES) {
      expect(s.key, JSON.stringify(s)).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(typeof s.fetch).toBe('function');
      if (s.requiresEnv) expect(typeof s.requiresEnv).toBe('string');
      if (s.requiresAnyEnv) {
        expect(Array.isArray(s.requiresAnyEnv)).toBe(true);
        expect(s.requiresAnyEnv.length).toBeGreaterThan(0);
      }
    }
  });

  it('keys are unique', () => {
    const keys = SOURCES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shared SourceKey list matches the registry exactly', () => {
    expect(SOURCES.map((s) => s.key).sort()).toEqual([...SOURCE_KEYS].sort());
  });

  it('has a healthy number of integrations', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(15);
  });
});

describe('activeSources', () => {
  it('with no env: only keyless, non-disabled sources', () => {
    const active = activeSources({});
    expect(active.length).toBeGreaterThanOrEqual(5);
    expect(active.every((s) => !s.requiresEnv && !s.requiresAnyEnv && !s.disabled)).toBe(true);
    // The dump-backed museums are inactive without a dump dataset configured.
    expect(active.some((s) => s.key === 'aic')).toBe(false);
    expect(active.some((s) => s.key === 'wikidata')).toBe(false);
    expect(active.some((s) => s.key === 'met')).toBe(false);
  });

  it('keeps a disabled source off even when its key is present', () => {
    const active = activeSources({ PARIS_MUSEES_TOKEN: 'x' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'parismusees')).toBe(false);
  });

  it('enables all dump-backed museums from the combined dump dataset', () => {
    const active = activeSources({ HARPE_DUMP_DATASET: 'owner/harpe-art' } as NodeJS.ProcessEnv);
    for (const key of ['moma', 'nga', 'mia', 'aic', 'cleveland', 'wellcome', 'smk', 'si', 'wikidata', 'met', 'loc', 'harvard', 'europeana']) {
      expect(active.some((s) => s.key === key)).toBe(true);
    }
  });

  it('enables a dump-backed museum from its per-source dump dataset', () => {
    const active = activeSources({ HARPE_MOMA_DUMP_DATASET: 'owner/harpe-moma' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'moma')).toBe(true);
    expect(active.some((s) => s.key === 'nga')).toBe(false);
    expect(active.some((s) => s.key === 'mia')).toBe(false);
  });

  it('never includes a disabled source, even with its key set', () => {
    const active = activeSources({ NYPL_API_TOKEN: 'x' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'nypl')).toBe(false);
  });
});

describe('mapPool (bounded-concurrency fan-out)', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapPool([30, 10, 20], 3, (ms) =>
      new Promise<number>((r) => setTimeout(() => r(ms), ms / 10)),
    );
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool([...Array(12).keys()], 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('maps a rejected item to null without failing the whole batch', async () => {
    const out = await mapPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(out).toEqual([10, null, 30]);
  });

  it('handles an empty input', async () => {
    expect(await mapPool([], 4, async (x) => x)).toEqual([]);
  });
});

describe('validateArtItem (the unified contract)', () => {
  it('accepts a well-formed item', () => {
    expect(validateArtItem(makeItem())).toEqual([]);
  });

  it('flags missing required fields', () => {
    expect(validateArtItem(makeItem({ id: '' }))).toContain('id missing/empty');
    expect(validateArtItem(makeItem({ title: '' }))).toContain('title missing/empty');
  });

  it('flags a non-URL image and a fully image-less item', () => {
    expect(validateArtItem(makeItem({ thumbUrl: 'not-a-url' })).join()).toContain('thumbUrl is not a URL');
    expect(validateArtItem(makeItem({ thumbUrl: '', previewUrl: '', fullUrl: '' }))).toContain(
      'no image URL (thumb/preview/full all empty)',
    );
  });

  it('flags wrong types + unknown source key', () => {
    expect(validateArtItem(makeItem({ isPublicDomain: 'yes' as unknown as boolean }))).toContain('isPublicDomain not boolean');
    expect(validateArtItem(makeItem({ source: 'nope' as unknown as ArtItem['source'] })).join()).toContain('unknown source key');
  });
});

// ─── Dump PD mapping (mirrors fetchDumpSearchUncached logic) ──────────────────
// The HF row field `is_public_domain` can be true | false | null (when the dump
// omitted the column). Only an explicit `true` must yield isPublicDomain=true.

function mapDumpPd(value: unknown): boolean {
  return value === true;
}

describe('dump is_public_domain mapping', () => {
  it('true → public domain', () => {
    expect(mapDumpPd(true)).toBe(true);
  });

  it('false → not public domain', () => {
    expect(mapDumpPd(false)).toBe(false);
  });

  it('null → not public domain (unknown rights must not be assumed PD)', () => {
    expect(mapDumpPd(null)).toBe(false);
  });

  it('undefined → not public domain', () => {
    expect(mapDumpPd(undefined)).toBe(false);
  });

  it('1 (truthy number) → not public domain (strict === true)', () => {
    expect(mapDumpPd(1)).toBe(false);
  });
});

// ─── Commons license detection (mirrors fetchCommons logic) ──────────────────
// extmetadata can be absent, partially populated, or carry various license strings.

function mapCommonsLicense(extmetadata?: {
  LicenseShortName?: { value?: unknown };
  License?: { value?: unknown };
  UsageTerms?: { value?: unknown };
}): boolean {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const licShort = str(extmetadata?.LicenseShortName?.value).toLowerCase();
  const licKey = str(extmetadata?.License?.value).toLowerCase();
  const usage = str(extmetadata?.UsageTerms?.value).toLowerCase();
  return (
    licShort.includes('cc0') || licShort.includes('public domain') ||
    licKey.includes('cc0') || licKey.includes('publicdomain') ||
    usage.includes('public domain') || usage.includes('no known copyright')
  );
}

describe('Commons extmetadata license mapping', () => {
  it('CC0 LicenseShortName → public domain', () => {
    expect(mapCommonsLicense({ LicenseShortName: { value: 'CC0' } })).toBe(true);
  });

  it('"Public Domain" LicenseShortName → public domain', () => {
    expect(mapCommonsLicense({ LicenseShortName: { value: 'Public Domain' } })).toBe(true);
  });

  it('CC-BY-SA LicenseShortName → not public domain', () => {
    expect(mapCommonsLicense({ LicenseShortName: { value: 'CC BY-SA 4.0' } })).toBe(false);
  });

  it('GFDL LicenseShortName → not public domain', () => {
    expect(mapCommonsLicense({ LicenseShortName: { value: 'GFDL' } })).toBe(false);
  });

  it('License key "publicdomain" → public domain', () => {
    expect(mapCommonsLicense({ License: { value: 'publicdomain' } })).toBe(true);
  });

  it('UsageTerms "public domain" → public domain', () => {
    expect(mapCommonsLicense({ UsageTerms: { value: 'This work is in the public domain.' } })).toBe(true);
  });

  it('UsageTerms "no known copyright" → public domain', () => {
    expect(mapCommonsLicense({ UsageTerms: { value: 'No known copyright restrictions.' } })).toBe(true);
  });

  it('missing extmetadata → false (defensive)', () => {
    expect(mapCommonsLicense(undefined)).toBe(false);
  });

  it('empty extmetadata → false (defensive)', () => {
    expect(mapCommonsLicense({})).toBe(false);
  });
});

// ─── IIIF image URL helper ────────────────────────────────────────────────────

import { iiifImage, IIIF } from './helpers.js';

describe('iiifImage helper', () => {
  const base = 'https://iiif.wellcomecollection.org/image/V0017241';

  it('produces the correct thumb URL (preserves byte-identity with original template)', () => {
    // Before: `${base}/full/!843,843/0/default.jpg`
    expect(iiifImage(base, IIIF.THUMB)).toBe(`${base}/full/!843,843/0/default.jpg`);
  });

  it('produces the correct preview URL', () => {
    // Before: `${base}/full/!1600,1600/0/default.jpg`
    expect(iiifImage(base, IIIF.PREVIEW)).toBe(`${base}/full/!1600,1600/0/default.jpg`);
  });

  it('produces the correct full URL', () => {
    // Before: `${base}/full/full/0/default.jpg`
    expect(iiifImage(base, IIIF.FULL)).toBe(`${base}/full/full/0/default.jpg`);
  });

  it('accepts an arbitrary size string', () => {
    expect(iiifImage(base, '512,')).toBe(`${base}/full/512,/0/default.jpg`);
  });
});

// ─── Enrichment field validation (new optional fields) ────────────────────────

describe('validateArtItem enrichment field typing', () => {
  it('accepts style and inscriptions as strings when present', () => {
    expect(validateArtItem(makeItem({ style: 'Impressionism', inscriptions: 'Signed lower right' }))).toEqual([]);
  });

  it('flags style not a string', () => {
    expect(validateArtItem(makeItem({ style: 42 as unknown as string }))).toContain('style not a string');
  });

  it('flags inscriptions not a string', () => {
    expect(validateArtItem(makeItem({ inscriptions: true as unknown as string }))).toContain('inscriptions not a string');
  });

  it('accepts well-formed tags array', () => {
    expect(validateArtItem(makeItem({ tags: ['painting', 'portrait'] }))).toEqual([]);
  });

  it('flags tags not an array', () => {
    expect(validateArtItem(makeItem({ tags: 'portrait' as unknown as string[] }))).toContain('tags not an array');
  });

  it('flags tags array containing non-string element', () => {
    expect(validateArtItem(makeItem({ tags: ['ok', 99 as unknown as string] }))).toContain('tags contains non-string element');
  });

  it('accepts accessionNumber and licenseUrl as strings when present', () => {
    expect(validateArtItem(makeItem({
      accessionNumber: '1926.1',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    }))).toEqual([]);
  });

  it('flags accessionNumber not a string', () => {
    expect(validateArtItem(makeItem({ accessionNumber: 123 as unknown as string }))).toContain('accessionNumber not a string');
  });

  it('all enrichment fields absent → still valid', () => {
    // Enrichment fields are all optional; omitting them must not produce problems.
    const base = makeItem();
    delete (base as Partial<ArtItem>).tags;
    delete (base as Partial<ArtItem>).style;
    delete (base as Partial<ArtItem>).inscriptions;
    delete (base as Partial<ArtItem>).accessionNumber;
    delete (base as Partial<ArtItem>).licenseUrl;
    delete (base as Partial<ArtItem>).artworkType;
    expect(validateArtItem(base)).toEqual([]);
  });
});

// ─── Adapter enrichment mapping (deterministic unit tests, no network) ─────────
// Each test mirrors the mapping logic inside the adapter using a minimal response
// fixture. These tests do NOT call the adapter directly (that would require a
// network or complex mocking); instead they exercise the same pure transformation
// logic that the adapter applies.

// ── Commons extmetadata → artist / date / licenseUrl / sourceUrl ──────────────
function mapCommonsEnrichment(
  extmetadata: {
    Artist?: { value?: string };
    DateTimeOriginal?: { value?: string };
    DateTime?: { value?: string };
    ImageDescription?: { value?: string };
    Credit?: { value?: string };
    LicenseUrl?: { value?: string };
  } | undefined,
  pageTitle: string,
): Pick<ArtItem, 'artist' | 'date' | 'description' | 'creditLine' | 'licenseUrl' | 'sourceUrl'> {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const rawArtist = s(extmetadata?.Artist?.value).replace(/<[^>]+>/g, '').trim();
  const rawDate = s(extmetadata?.DateTimeOriginal?.value) || s(extmetadata?.DateTime?.value);
  const rawDesc = s(extmetadata?.ImageDescription?.value).replace(/<[^>]+>/g, '').trim();
  const rawCredit = s(extmetadata?.Credit?.value).replace(/<[^>]+>/g, '').trim();
  const rawLicUrl = s(extmetadata?.LicenseUrl?.value).trim();
  const sourceUrl = pageTitle
    ? `https://commons.wikimedia.org/wiki/${pageTitle.replace(/ /g, '_')}`
    : undefined;
  return {
    artist: rawArtist || '',
    date: rawDate || undefined,
    description: rawDesc || undefined,
    creditLine: rawCredit || undefined,
    licenseUrl: rawLicUrl || undefined,
    sourceUrl,
  };
}

describe('Commons extmetadata enrichment mapping', () => {
  it('maps Artist → artist (strips HTML tags)', () => {
    const out = mapCommonsEnrichment(
      { Artist: { value: '<a href="/wiki/Monet">Claude Monet</a>' } },
      'File:Monet_Water_Lilies.jpg',
    );
    expect(out.artist).toBe('Claude Monet');
  });

  it('maps DateTimeOriginal → date, LicenseUrl → licenseUrl', () => {
    const out = mapCommonsEnrichment(
      { DateTimeOriginal: { value: '1906' }, LicenseUrl: { value: 'https://creativecommons.org/publicdomain/zero/1.0/' } },
      'File:Test.jpg',
    );
    expect(out.date).toBe('1906');
    expect(out.licenseUrl).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
  });

  it('builds sourceUrl from pageTitle replacing spaces with underscores', () => {
    const out = mapCommonsEnrichment(undefined, 'File:My Image.jpg');
    expect(out.sourceUrl).toBe('https://commons.wikimedia.org/wiki/File:My_Image.jpg');
  });

  it('returns empty sourceUrl when pageTitle is blank', () => {
    const out = mapCommonsEnrichment(undefined, '');
    expect(out.sourceUrl).toBeUndefined();
  });

  it('prefers DateTimeOriginal over DateTime', () => {
    const out = mapCommonsEnrichment(
      { DateTimeOriginal: { value: '1850' }, DateTime: { value: '2001-01-01' } },
      'File:X.jpg',
    );
    expect(out.date).toBe('1850');
  });
});

// ── Cleveland creditLine + accessionNumber + artworkType mapping ───────────────
function mapClevelandItem(d: {
  creditline?: string;
  accession_number?: string;
  type?: string;
  share_license_status?: string;
}): Pick<ArtItem, 'creditLine' | 'accessionNumber' | 'artworkType' | 'isPublicDomain'> {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    creditLine: s(d.creditline) || undefined,
    accessionNumber: s(d.accession_number) || undefined,
    artworkType: s(d.type) || undefined,
    isPublicDomain: s(d.share_license_status).toUpperCase() === 'CC0',
  };
}

describe('Cleveland enrichment mapping', () => {
  it('maps creditline → creditLine', () => {
    expect(mapClevelandItem({ creditline: 'Gift of the Artist' }).creditLine).toBe('Gift of the Artist');
  });

  it('maps accession_number → accessionNumber', () => {
    expect(mapClevelandItem({ accession_number: '1916.1005' }).accessionNumber).toBe('1916.1005');
  });

  it('maps type → artworkType', () => {
    expect(mapClevelandItem({ type: 'Painting' }).artworkType).toBe('Painting');
  });

  it('empty creditline → creditLine undefined', () => {
    expect(mapClevelandItem({ creditline: '' }).creditLine).toBeUndefined();
  });

  it('CC0 share_license_status → isPublicDomain true', () => {
    expect(mapClevelandItem({ share_license_status: 'CC0' }).isPublicDomain).toBe(true);
  });

  it('non-CC0 share_license_status → isPublicDomain false', () => {
    expect(mapClevelandItem({ share_license_status: 'CC BY-SA' }).isPublicDomain).toBe(false);
  });
});

// ── Met tags + additionalImages downloads mapping ─────────────────────────────
function mapMetEnrichment(d: {
  tags?: Array<{ term?: string }>;
  additionalImages?: string[];
  period?: string;
  dynasty?: string;
  accessionNumber?: string;
  primaryImage: string;
}): Pick<ArtItem, 'tags' | 'downloads' | 'style' | 'accessionNumber'> {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const metTags = Array.isArray(d.tags)
    ? d.tags.map((t) => s(t?.term)).filter(Boolean)
    : undefined;
  const tags = metTags?.length ? metTags : undefined;
  const downloads: ArtItem['downloads'] = [{ label: 'Full JPEG', url: d.primaryImage, format: 'jpeg', lossless: false }];
  if (Array.isArray(d.additionalImages)) {
    for (const imgUrl of d.additionalImages) {
      const u = s(imgUrl);
      if (u) downloads.push({ label: 'Additional JPEG', url: u, format: 'jpeg', lossless: false });
    }
  }
  const style = s(d.period) || s(d.dynasty) || undefined;
  const accessionNumber = s(d.accessionNumber) || undefined;
  return { tags, downloads, style, accessionNumber };
}

describe('Met enrichment mapping', () => {
  it('maps tags[].term → tags array', () => {
    const out = mapMetEnrichment({
      tags: [{ term: 'Landscapes' }, { term: 'Water' }],
      primaryImage: 'https://x/img.jpg',
    });
    expect(out.tags).toEqual(['Landscapes', 'Water']);
  });

  it('maps additionalImages → extra download entries', () => {
    const out = mapMetEnrichment({
      additionalImages: ['https://x/a.jpg', 'https://x/b.jpg'],
      primaryImage: 'https://x/img.jpg',
    });
    expect(out.downloads).toHaveLength(3);
    expect(out.downloads[1].url).toBe('https://x/a.jpg');
    expect(out.downloads[1].label).toBe('Additional JPEG');
  });

  it('maps period → style', () => {
    expect(mapMetEnrichment({ period: 'New Kingdom', primaryImage: 'https://x/img.jpg' }).style).toBe('New Kingdom');
  });

  it('maps dynasty as fallback style when period absent', () => {
    expect(mapMetEnrichment({ dynasty: '18th Dynasty', primaryImage: 'https://x/img.jpg' }).style).toBe('18th Dynasty');
  });

  it('maps accessionNumber', () => {
    expect(mapMetEnrichment({ accessionNumber: '10.32', primaryImage: 'https://x/img.jpg' }).accessionNumber).toBe('10.32');
  });

  it('empty tags array → tags undefined', () => {
    expect(mapMetEnrichment({ tags: [], primaryImage: 'https://x/img.jpg' }).tags).toBeUndefined();
  });
});

// ── Harvard width/height + artworkType + style + tags mapping ─────────────────
function mapHarvardEnrichment(r: {
  images?: Array<{ width?: number; height?: number }>;
  classification?: string;
  period?: string;
  century?: string;
  worktypes?: Array<{ worktype?: string }>;
}): Pick<ArtItem, 'width' | 'height' | 'artworkType' | 'style' | 'tags'> {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const img0 = r.images?.[0];
  const width = img0 ? (Number(img0.width) || undefined) : undefined;
  const height = img0 ? (Number(img0.height) || undefined) : undefined;
  const artworkType = s(r.classification) || undefined;
  const style = s(r.period) || s(r.century) || undefined;
  const worktypeArr = Array.isArray(r.worktypes)
    ? r.worktypes.map((wt) => s(wt.worktype)).filter(Boolean)
    : [];
  const tags = worktypeArr.length ? worktypeArr : undefined;
  return { width, height, artworkType, style, tags };
}

describe('Harvard enrichment mapping', () => {
  it('maps images[0].width/height → width/height', () => {
    const out = mapHarvardEnrichment({ images: [{ width: 2048, height: 1536 }] });
    expect(out.width).toBe(2048);
    expect(out.height).toBe(1536);
  });

  it('no images → width/height undefined', () => {
    const out = mapHarvardEnrichment({});
    expect(out.width).toBeUndefined();
    expect(out.height).toBeUndefined();
  });

  it('maps classification → artworkType', () => {
    expect(mapHarvardEnrichment({ classification: 'Paintings' }).artworkType).toBe('Paintings');
  });

  it('maps period → style', () => {
    expect(mapHarvardEnrichment({ period: 'Baroque' }).style).toBe('Baroque');
  });

  it('maps century as fallback style when period absent', () => {
    expect(mapHarvardEnrichment({ century: '17th century' }).style).toBe('17th century');
  });

  it('maps worktypes → tags', () => {
    const out = mapHarvardEnrichment({ worktypes: [{ worktype: 'Painting' }, { worktype: 'Oil' }] });
    expect(out.tags).toEqual(['Painting', 'Oil']);
  });
});

// ── Smithsonian freetext mapping ──────────────────────────────────────────────
function mapSmithsonianFreetext(freetext: {
  date?: Array<{ content: string }>;
  physicalDescription?: Array<{ content: string }>;
  place?: Array<{ content: string }>;
  creditLine?: Array<{ content: string }>;
  notes?: Array<{ content: string }>;
  topic?: Array<{ content: string }>;
}): Pick<ArtItem, 'date' | 'medium' | 'culture' | 'creditLine' | 'description' | 'tags'> {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const date = freetext.date?.[0] ? s(freetext.date[0].content) : undefined;
  const medium = freetext.physicalDescription?.[0] ? s(freetext.physicalDescription[0].content) : undefined;
  const culture = freetext.place?.[0] ? s(freetext.place[0].content) : undefined;
  const creditLine = freetext.creditLine?.[0] ? s(freetext.creditLine[0].content) : undefined;
  const description = freetext.notes?.[0] ? s(freetext.notes[0].content) : undefined;
  const topicArr = Array.isArray(freetext.topic)
    ? freetext.topic.map((t) => s(t.content)).filter(Boolean)
    : [];
  const tags = topicArr.length ? topicArr : undefined;
  return { date, medium, culture, creditLine, description, tags };
}

describe('Smithsonian freetext enrichment mapping', () => {
  it('maps date[0].content → date', () => {
    expect(mapSmithsonianFreetext({ date: [{ content: '1942' }] }).date).toBe('1942');
  });

  it('maps physicalDescription[0].content → medium', () => {
    expect(mapSmithsonianFreetext({ physicalDescription: [{ content: 'Oil on canvas' }] }).medium).toBe('Oil on canvas');
  });

  it('maps place[0].content → culture', () => {
    expect(mapSmithsonianFreetext({ place: [{ content: 'Washington D.C.' }] }).culture).toBe('Washington D.C.');
  });

  it('maps creditLine[0].content → creditLine', () => {
    expect(mapSmithsonianFreetext({ creditLine: [{ content: 'Gift of the Estate' }] }).creditLine).toBe('Gift of the Estate');
  });

  it('maps notes[0].content → description', () => {
    expect(mapSmithsonianFreetext({ notes: [{ content: 'A great work.' }] }).description).toBe('A great work.');
  });

  it('maps topic[] → tags', () => {
    const out = mapSmithsonianFreetext({ topic: [{ content: 'War' }, { content: 'History' }] });
    expect(out.tags).toEqual(['War', 'History']);
  });

  it('missing topic → tags undefined', () => {
    expect(mapSmithsonianFreetext({}).tags).toBeUndefined();
  });
});

// ── AIC artworkType / tags / style mapping ────────────────────────────────────
function mapAicEnrichment(d: {
  artwork_type_title?: string;
  classification_titles?: string[];
  subject_titles?: string[];
  style_titles?: string[];
  inscriptions?: string;
  main_reference_number?: string;
}): Pick<ArtItem, 'artworkType' | 'tags' | 'style' | 'inscriptions' | 'accessionNumber'> {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const artworkType = s(d.artwork_type_title) || undefined;
  const tagArr: string[] = [];
  if (Array.isArray(d.classification_titles)) tagArr.push(...d.classification_titles.map(s).filter(Boolean));
  if (Array.isArray(d.subject_titles)) tagArr.push(...d.subject_titles.map(s).filter(Boolean));
  const tags = tagArr.length ? tagArr : undefined;
  const styleTitles = Array.isArray(d.style_titles) ? d.style_titles.map(s).filter(Boolean) : [];
  const style = styleTitles.length ? styleTitles[0] : undefined;
  const inscriptions = s(d.inscriptions) || undefined;
  const accessionNumber = s(d.main_reference_number) || undefined;
  return { artworkType, tags, style, inscriptions, accessionNumber };
}

describe('AIC enrichment mapping', () => {
  it('maps artwork_type_title → artworkType', () => {
    expect(mapAicEnrichment({ artwork_type_title: 'Painting' }).artworkType).toBe('Painting');
  });

  it('combines classification_titles + subject_titles → tags', () => {
    const out = mapAicEnrichment({
      classification_titles: ['Painting'],
      subject_titles: ['Flowers', 'Water'],
    });
    expect(out.tags).toEqual(['Painting', 'Flowers', 'Water']);
  });

  it('maps first style_titles entry → style', () => {
    expect(mapAicEnrichment({ style_titles: ['French Impressionism', 'Post-Impressionism'] }).style).toBe('French Impressionism');
  });

  it('maps inscriptions', () => {
    expect(mapAicEnrichment({ inscriptions: 'C. Monet 1906' }).inscriptions).toBe('C. Monet 1906');
  });

  it('maps main_reference_number → accessionNumber', () => {
    expect(mapAicEnrichment({ main_reference_number: '1926.224' }).accessionNumber).toBe('1926.224');
  });

  it('empty style_titles → style undefined', () => {
    expect(mapAicEnrichment({ style_titles: [] }).style).toBeUndefined();
  });
});

// ── Europeana licenseUrl / tags / artworkType mapping ─────────────────────────
function mapEuropeanaEnrichment(it: {
  edmRights?: string[];
  dcSubject?: unknown;
  dcType?: string[];
  dctermsExtent?: string[];
}): Pick<ArtItem, 'licenseUrl' | 'tags' | 'artworkType' | 'dimensions'> {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const first = (v: unknown) => (Array.isArray(v) ? s((v as unknown[])[0]) : s(v));
  const rights = first(it.edmRights);
  const licenseUrl = (rights && /^https?:\/\//i.test(rights)) ? rights : undefined;
  const subjectRaw = it.dcSubject;
  const subjectArr = Array.isArray(subjectRaw)
    ? (subjectRaw as unknown[]).map(s).filter(Boolean)
    : s(subjectRaw) ? [s(subjectRaw)] : [];
  const tags = subjectArr.length ? subjectArr : undefined;
  const artworkType = first(it.dcType) || undefined;
  const dimensions = first(it.dctermsExtent) || '';
  return { licenseUrl, tags, artworkType, dimensions };
}

describe('Europeana enrichment mapping', () => {
  it('maps edmRights URL → licenseUrl', () => {
    const out = mapEuropeanaEnrichment({
      edmRights: ['http://creativecommons.org/publicdomain/zero/1.0/'],
    });
    expect(out.licenseUrl).toBe('http://creativecommons.org/publicdomain/zero/1.0/');
  });

  it('non-URL edmRights → licenseUrl undefined', () => {
    expect(mapEuropeanaEnrichment({ edmRights: ['InC-1.0'] }).licenseUrl).toBeUndefined();
  });

  it('maps dcSubject array → tags', () => {
    const out = mapEuropeanaEnrichment({ dcSubject: ['Architecture', 'Netherlands'] });
    expect(out.tags).toEqual(['Architecture', 'Netherlands']);
  });

  it('maps dcType → artworkType', () => {
    expect(mapEuropeanaEnrichment({ dcType: ['IMAGE', 'Painting'] }).artworkType).toBe('IMAGE');
  });

  it('maps dctermsExtent → dimensions', () => {
    expect(mapEuropeanaEnrichment({ dctermsExtent: ['100 x 80 cm'] }).dimensions).toBe('100 x 80 cm');
  });

  it('missing edmRights → licenseUrl undefined', () => {
    expect(mapEuropeanaEnrichment({}).licenseUrl).toBeUndefined();
  });
});
