import { describe, it, expect } from 'vitest';
import {
  suggest, ALL_SUGGESTIONS, ARTISTS, MOVEMENTS, THEMES,
  FEATURED_ARTISTS, FEATURED_MOVEMENTS, FEATURED_THEMES,
} from './discover';
import { normalize } from '@harpe/core';

const labels = (q: string, n?: number) => suggest(q, n).map((s) => s.label);

describe('suggest()', () => {
  it('returns nothing for an empty/blank query (discovery shown instead)', () => {
    expect(suggest('')).toEqual([]);
    expect(suggest('   ')).toEqual([]);
  });

  it('ranks a prefix match first', () => {
    expect(labels('monet')[0]).toBe('Claude Monet');
  });

  it('folds diacritics ("durer" → Dürer)', () => {
    expect(labels('durer')).toContain('Albrecht Dürer');
  });

  it('tolerates a small typo ("picaso" → Picasso)', () => {
    expect(labels('picaso')).toContain('Pablo Picasso');
  });

  it('matches a later word in a multi-word name ("gogh" → van Gogh)', () => {
    expect(labels('gogh')).toContain('Vincent van Gogh');
  });

  it('handles a partial multi-word query ("van gogh")', () => {
    expect(labels('van gogh')[0]).toBe('Vincent van Gogh');
  });

  it('never suggests the query the user already typed exactly', () => {
    expect(labels('Claude Monet')).not.toContain('Claude Monet');
  });

  it('finds movements and themes too', () => {
    expect(labels('impress')).toContain('Impressionism');
    expect(suggest('wave').map((s) => s.query)).toContain('the great wave');
  });

  it('tags each suggestion with its kind', () => {
    const monet = suggest('monet').find((s) => s.label === 'Claude Monet');
    expect(monet?.kind).toBe('artist');
  });

  it('respects the limit', () => {
    expect(suggest('e', 3).length).toBeLessThanOrEqual(3);
  });

  it('biases artists above themes/movements on an equal textual match', () => {
    // "pop" prefixes both an artist field and the "Pop Art" movement; ensure a
    // real artist-name prefix still leads where one exists.
    const top = suggest('rem')[0];
    expect(top.label).toBe('Rembrandt van Rijn');
  });
});

describe('curated data integrity', () => {
  it('has no duplicate queries across the whole pool', () => {
    const keys = ALL_SUGGESTIONS.map((s) => normalize(s.query));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has a non-empty label, query and hint', () => {
    for (const s of ALL_SUGGESTIONS) {
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.query.trim().length).toBeGreaterThan(0);
      expect(s.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('has a healthy spread of each kind', () => {
    expect(ARTISTS.length).toBeGreaterThanOrEqual(40);
    expect(MOVEMENTS.length).toBeGreaterThanOrEqual(12);
    expect(THEMES.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves every featured entry (no undefined from .find lookups)', () => {
    for (const list of [FEATURED_ARTISTS, FEATURED_MOVEMENTS, FEATURED_THEMES]) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.every(Boolean)).toBe(true);
    }
  });
});
