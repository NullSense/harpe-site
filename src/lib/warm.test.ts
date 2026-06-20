import { describe, it, expect } from 'vitest';
// The keep-warm runner is a dependency-free Node script (like tests/live/monitor.mjs)
// so CI can `node` it directly. Its one pure, testable piece — choosing which
// queries to warm — is exported and unit-tested here.
import { pickWarmQueries, summarizeWarm, clampCount } from '../../tests/live/keep-warm.mjs';

describe('pickWarmQueries', () => {
  const sugg = (rows: Array<Partial<{ query: string; label: string; kind: string }>>) =>
    ({ suggestions: rows });

  it('takes the top-N in fame order (suggest.json is pre-ranked)', () => {
    const payload = sugg([
      { query: 'Claude Monet' }, { query: 'Vincent van Gogh' }, { query: 'Rembrandt' },
    ]);
    expect(pickWarmQueries(payload, 2)).toEqual(['Claude Monet', 'Vincent van Gogh']);
  });

  it('dedupes case-insensitively, keeping the first occurrence', () => {
    const payload = sugg([{ query: 'Monet' }, { query: 'monet' }, { query: 'Cézanne' }]);
    expect(pickWarmQueries(payload, 10)).toEqual(['Monet', 'Cézanne']);
  });

  it('skips empty and too-short (<3 char) queries', () => {
    const payload = sugg([{ query: '' }, { query: 'ox' }, { query: 'cat' }]);
    expect(pickWarmQueries(payload, 10)).toEqual(['cat']);
  });

  it('falls back to label when query is absent', () => {
    const payload = sugg([{ label: 'Hokusai' }]);
    expect(pickWarmQueries(payload, 10)).toEqual(['Hokusai']);
  });

  it('accepts a bare array as well as a {suggestions} envelope', () => {
    expect(pickWarmQueries([{ query: 'Klimt' }], 10)).toEqual(['Klimt']);
  });

  it('returns [] for empty or malformed input', () => {
    expect(pickWarmQueries(null, 10)).toEqual([]);
    expect(pickWarmQueries({}, 10)).toEqual([]);
    expect(pickWarmQueries({ suggestions: [] }, 10)).toEqual([]);
  });
});

describe('clampCount', () => {
  it('parses and clamps to [1, max]', () => {
    expect(clampCount('5', 100, 24)).toBe(5);
    expect(clampCount('0', 100, 24)).toBe(1);
    expect(clampCount('999', 100, 24)).toBe(100);
  });
  it('falls back to the default for non-numeric/missing input', () => {
    expect(clampCount('abc', 100, 24)).toBe(24);
    expect(clampCount(undefined, 100, 24)).toBe(24);
  });
});

describe('summarizeWarm', () => {
  const rs = (oks: boolean[]) => oks.map((ok) => ({ ok }));
  it('passes only when the success ratio meets the threshold', () => {
    expect(summarizeWarm(rs([true, true, true, true, false]), 0.8).pass).toBe(true); // 4/5
    expect(summarizeWarm(rs([true, true, true, false, false]), 0.8).pass).toBe(false); // 3/5
  });
  it('fails on an empty result set (not a vacuous pass)', () => {
    expect(summarizeWarm([], 0.8).pass).toBe(false);
  });
  it('reports ok/total/ratio', () => {
    const s = summarizeWarm(rs([true, false]), 0.5);
    expect(s.ok).toBe(1);
    expect(s.total).toBe(2);
    expect(s.ratio).toBe(0.5);
  });
});
