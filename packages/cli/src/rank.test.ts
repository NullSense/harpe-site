/**
 * Tests for rank.ts — ported from harpe/tests/test_rank.py.
 * Updated to use ArtItem instead of Candidate (monorepo-phase1 refactor).
 */
import { describe, it, expect } from 'vitest';
import type { ArtItem } from '@harpe/core';
import { tokens, rank } from './rank.js';

/** Minimal ArtItem fixture builder for rank tests. */
function item(fields: Partial<ArtItem> & { fullUrl?: string; thumbUrl?: string; width?: number; height?: number }): ArtItem {
  return {
    id: 'test-' + Math.random(),
    title: '',
    artist: '',
    dimensions: '',
    thumbUrl: fields.thumbUrl ?? '',
    previewUrl: '',
    fullUrl: fields.fullUrl ?? '',
    format: 'jpeg',
    lossless: false,
    downloads: [],
    source: 'aic',
    isPublicDomain: true,
    // area is computed from width×height in rank()
    width: fields.width ?? (fields.fullUrl ? 1000 : 0),
    height: fields.height ?? (fields.fullUrl ? 1000 : 0),
    ...fields,
  };
}

describe('tokens', () => {
  it('drops stopwords and short words', () => {
    expect(tokens('The Last Day of Pompeii')).toEqual(['last', 'day', 'pompeii']);
  });

  it('lowercases and splits on punctuation', () => {
    expect(tokens('Moses-Breaketh: Tables!')).toEqual(['moses', 'breaketh', 'tables']);
  });

  it('drops tokens shorter than 3 chars', () => {
    expect(tokens('a ab abc')).toEqual(['abc']);
  });

  it('handles empty string', () => {
    expect(tokens('')).toEqual([]);
  });
});

describe('rank', () => {
  it('relevance beats resolution — exact match wins over giant irrelevant scan', () => {
    const bigWrong = item({ width: 31623, height: 31623, title: 'Mona Lisa', artist: 'Leonardo', fullUrl: 'a' }); // ~1e9
    const smallRight = item({ width: 1000, height: 1000, title: 'The Last Day of Pompeii', artist: 'Karl Bryullov', fullUrl: 'b' }); // 1e6
    const out = rank('the last day of pompeii bryullov', [bigWrong, smallRight]);
    expect(out[0]).toBe(smallRight);
  });

  it('strong match (>=4 tokens) trims low-relevance noise', () => {
    const good = item({ width: 1000, height: 1000, title: 'Moses Breaketh the Tables', artist: 'John Martin', fullUrl: 'url-a' });
    const noise = item({ width: 31623, height: 31623, title: 'Nude on a Table', artist: 'John Currin', fullUrl: 'url-b' });
    const out = rank('moses breaketh the tables john martin', [good, noise]);
    expect(out).toContain(good);
    expect(out).not.toContain(noise);
  });

  it('weak query (one token) keeps everything — floor is 0', () => {
    const a = item({ width: 1000, height: 1000, title: 'Sunset', fullUrl: 'url-a' });
    const b = item({ width: 316, height: 316, title: 'Sunrise', fullUrl: 'url-b' });
    const out = rank('art', [a, b]);
    expect(out).toHaveLength(2);
  });

  it('dedup by fullUrl — larger area wins, duplicate dropped', () => {
    const a = item({ width: 1000, height: 1000, title: 'X', fullUrl: 'same-url' });
    const b = item({ width: 316, height: 316, title: 'X', fullUrl: 'same-url' });
    const out = rank('x', [a, b]);
    expect(out).toEqual([a]);
  });

  it('bigger scan of the same work ranks first when tied on relevance', () => {
    const small = item({ width: 1000, height: 1000, title: 'The Deluge', artist: 'Martin', fullUrl: 'url-s' });
    const large = item({ width: 10000, height: 10000, title: 'The Deluge', artist: 'Martin', fullUrl: 'url-l' });
    const out = rank('the deluge martin', [small, large]);
    expect(out[0]).toBe(large);
  });

  it('returns empty array for empty input', () => {
    expect(rank('anything', [])).toEqual([]);
  });

  it('dedup falls back to thumbUrl when fullUrl is empty', () => {
    const a = item({ width: 1000, height: 1000, title: 'X', fullUrl: '', thumbUrl: 'https://same.jpg' });
    const b = item({ width: 316, height: 316, title: 'X', fullUrl: '', thumbUrl: 'https://same.jpg' });
    const out = rank('x', [a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(a);
  });

  it('floor is exactly 2 when maxRel >= 4', () => {
    // Query with 4+ meaningful tokens; item with rel=1 must be trimmed.
    const strong = item({ width: 1000, height: 1000, title: 'moses breaketh the tables', artist: 'john martin', fullUrl: 'url-a' });
    const weak = item({ width: 31623, height: 31623, title: 'morning sunrise', artist: 'unknown', fullUrl: 'url-b' });
    const out = rank('moses breaketh tables john martin', [strong, weak]);
    // strong has 5 token hits, weak has 0 — floor=2 removes weak
    expect(out).toContain(strong);
    expect(out).not.toContain(weak);
  });
});
