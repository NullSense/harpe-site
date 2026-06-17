import { describe, it, expect } from 'vitest';
import { SOURCE_KEYS, validateArtItem, type ArtItem } from '@harpe/core';
import { SOURCES, activeSources, mapPool } from './art.js';

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
    expect(active.length).toBeGreaterThanOrEqual(12);
    expect(active.every((s) => !s.requiresEnv && !s.requiresAnyEnv && !s.disabled)).toBe(true);
  });

  it('enables a keyed source when its env var is present', () => {
    const active = activeSources({ EUROPEANA_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'europeana')).toBe(true);
  });

  it('enables dump-backed museums from the combined dump dataset', () => {
    const active = activeSources({ HARPE_DUMP_DATASET: 'owner/harpe-art' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'moma')).toBe(true);
    expect(active.some((s) => s.key === 'nga')).toBe(true);
    expect(active.some((s) => s.key === 'mia')).toBe(true);
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
