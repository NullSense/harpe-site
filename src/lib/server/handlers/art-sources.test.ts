import { describe, it, expect } from 'vitest';
import { SOURCE_KEYS, validateArtItem, type ArtItem } from '@harpe/core';
import { SOURCES, activeSources, mapPool } from '@harpe/sources';

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
    expect(active.length).toBeGreaterThanOrEqual(6);
    expect(active.every((s) => !s.requiresEnv && !s.requiresAnyEnv && !s.disabled)).toBe(true);
    // The dump-backed museums are inactive without a dump dataset configured.
    expect(active.some((s) => s.key === 'aic')).toBe(false);
    expect(active.some((s) => s.key === 'wikidata')).toBe(false);
  });

  it('enables a keyed source when its env var is present', () => {
    const active = activeSources({ EUROPEANA_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'europeana')).toBe(true);
  });

  it('enables all dump-backed museums from the combined dump dataset', () => {
    const active = activeSources({ HARPE_DUMP_DATASET: 'owner/harpe-art' } as NodeJS.ProcessEnv);
    for (const key of ['moma', 'nga', 'mia', 'aic', 'cleveland', 'wellcome', 'smk', 'si', 'wikidata']) {
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

import { iiifImage, IIIF } from '../../../../packages/sources/src/helpers.js';

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
