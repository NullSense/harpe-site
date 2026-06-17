/**
 * Tests for rank.ts — ported from harpe/tests/test_rank.py.
 */
import { describe, it, expect } from 'vitest';
import type { Candidate } from './models.js';
import { tokens, rank } from './rank.js';

function cand(fields: Partial<Candidate>): Candidate {
  return {
    area: 0, res: '?', source: '', title: '', artist: '',
    date: '', spec: '', thumb: '', medium: '', desc: '', physdim: '',
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
    const bigWrong = cand({ area: 1e9, title: 'Mona Lisa', artist: 'Leonardo' });
    const smallRight = cand({ area: 1e6, title: 'The Last Day of Pompeii', artist: 'Karl Bryullov' });
    const out = rank('the last day of pompeii bryullov', [bigWrong, smallRight]);
    expect(out[0]).toBe(smallRight);
  });

  it('strong match (>=4 tokens) trims low-relevance noise', () => {
    const good = cand({ area: 1e6, title: 'Moses Breaketh the Tables', artist: 'John Martin', spec: 'url:a' });
    const noise = cand({ area: 1e9, title: 'Nude on a Table', artist: 'John Currin', spec: 'url:b' });
    const out = rank('moses breaketh the tables john martin', [good, noise]);
    expect(out).toContain(good);
    expect(out).not.toContain(noise);
  });

  it('weak query (one token) keeps everything — floor is 0', () => {
    const a = cand({ area: 1e6, title: 'Sunset', spec: 'url:a' });
    const b = cand({ area: 1e5, title: 'Sunrise', spec: 'url:b' });
    const out = rank('art', [a, b]);
    expect(out).toHaveLength(2);
  });

  it('dedup by spec — larger area wins, duplicate dropped', () => {
    const a = cand({ area: 1e6, title: 'X', spec: 'url:same' });
    const b = cand({ area: 1e5, title: 'X', spec: 'url:same' });
    const out = rank('x', [a, b]);
    expect(out).toEqual([a]);
  });

  it('bigger scan of the same work ranks first when tied on relevance', () => {
    const small = cand({ area: 1e6, title: 'The Deluge', artist: 'Martin', spec: 'url:s' });
    const large = cand({ area: 1e8, title: 'The Deluge', artist: 'Martin', spec: 'url:l' });
    const out = rank('the deluge martin', [small, large]);
    expect(out[0]).toBe(large);
  });

  it('returns empty array for empty input', () => {
    expect(rank('anything', [])).toEqual([]);
  });

  it('dedup falls back to thumb when spec is empty', () => {
    const a = cand({ area: 1e6, title: 'X', spec: '', thumb: 'https://same.jpg' });
    const b = cand({ area: 1e5, title: 'X', spec: '', thumb: 'https://same.jpg' });
    const out = rank('x', [a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(a);
  });

  it('floor is exactly 2 when maxRel >= 4', () => {
    // Query with 4+ meaningful tokens; item with rel=1 must be trimmed.
    const strong = cand({ area: 1e6, title: 'moses breaketh the tables', artist: 'john martin', spec: 'url:a' });
    const weak = cand({ area: 1e9, title: 'morning sunrise', artist: 'unknown', spec: 'url:b' });
    const out = rank('moses breaketh tables john martin', [strong, weak]);
    // strong has 5 token hits, weak has 0 — floor=2 removes weak
    expect(out).toContain(strong);
    expect(out).not.toContain(weak);
  });
});
