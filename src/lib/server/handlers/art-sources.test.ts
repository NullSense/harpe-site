import { describe, it, expect } from 'vitest';
import { SOURCES, activeSources, validateArtItem, type ArtItem } from './art.js';

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
    }
  });

  it('keys are unique', () => {
    const keys = SOURCES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has a healthy number of integrations', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(12);
  });
});

describe('activeSources', () => {
  it('with no env: only keyless, non-disabled sources', () => {
    const active = activeSources({});
    expect(active.length).toBeGreaterThanOrEqual(12);
    expect(active.every((s) => !s.requiresEnv && !s.disabled)).toBe(true);
  });

  it('enables a keyed source when its env var is present', () => {
    const active = activeSources({ EUROPEANA_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'europeana')).toBe(true);
  });

  it('never includes a disabled source, even with its key set', () => {
    const active = activeSources({ NYPL_API_TOKEN: 'x' } as NodeJS.ProcessEnv);
    expect(active.some((s) => s.key === 'nypl')).toBe(false);
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
