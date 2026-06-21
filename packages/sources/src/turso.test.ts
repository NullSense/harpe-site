import { describe, it, expect, vi } from 'vitest';
import { buildTursoSearch, buildTursoFuzzy, ftsMatch, tursoFilterRows, tursoFuzzyRows } from './turso.js';

describe('ftsMatch', () => {
  it('turns alnum tokens into quoted prefix terms (implicit AND)', () => {
    expect(ftsMatch('Jan Matejko')).toBe('"jan"* "matejko"*');
  });
  it('strips FTS5-special characters so input cannot break or widen the match', () => {
    expect(ftsMatch('"art*" (x)')).toBe('"art"*'); // x is 1 char → dropped; quotes/parens/star stripped
  });
  it('is empty for a query with no usable token', () => {
    expect(ftsMatch('  "  ')).toBe('');
  });
});

describe('buildTursoSearch', () => {
  it('builds a parameterized FTS query (MATCH ?, ORDER BY rank, LIMIT ?)', () => {
    const r = buildTursoSearch('Jan Matejko', { limit: 40 })!;
    expect(r.sql).toContain('FROM art_fts f JOIN art a ON a.rowid = f.rowid');
    expect(r.sql).toContain('WHERE art_fts MATCH ?');
    expect(r.sql).toContain('ORDER BY rank LIMIT ?');
    expect(r.args).toEqual(['"jan"* "matejko"*', 40]);
  });
  it('scopes to a source (per-source fan-out invariant) with the source arg after MATCH', () => {
    const r = buildTursoSearch('water lilies', { source: 'aic', limit: 100 })!;
    expect(r.sql).toContain('MATCH ? AND a.source = ?');
    expect(r.args).toEqual(['"water"* "lilies"*', 'aic', 100]);
  });
  it('keeps args aligned across source + facets (order = SQL order)', () => {
    const r = buildTursoSearch('lilies', { source: 'aic', facets: { artistQid: 'q296' } })!;
    expect(r.sql).toContain('MATCH ? AND a.source = ? AND a.artist_qid = ?');
    expect(r.args).toEqual(['"lilies"*', 'aic', 'Q296', 100]); // QID upper-cased, default limit
  });
  it('depicts_qids + movement facets are LIKE substrings', () => {
    expect(buildTursoSearch('x art', { facets: { depictsQid: 'Q7569' } })!.args).toEqual(['"art"*', '%Q7569%', 100]);
    expect(buildTursoSearch('x art', { facets: { movement: 'Impressionism' } })!.args).toEqual(['"art"*', '%Impressionism%', 100]);
  });
  it('allows a facet-only query (no text) but rejects bare source-only (no match-all scan)', () => {
    expect(buildTursoSearch('', { facets: { depictsQid: 'Q7569' }, limit: 50 })!.args).toEqual(['%Q7569%', 50]);
    expect(buildTursoSearch('', { source: 'aic' })).toBeNull();       // source alone → no scan
    expect(buildTursoSearch('', { facets: { artistQid: 'bad' } })).toBeNull();
  });
  it('clamps the limit to [1, 500]', () => {
    expect(buildTursoSearch('x art', { limit: 9999 })!.args.at(-1)).toBe(500);
    expect(buildTursoSearch('x art', { limit: 0 })!.args.at(-1)).toBe(1);
  });
});

describe('buildTursoFuzzy', () => {
  it('builds a Jaro-Winkler fallback over artist + title', () => {
    const r = buildTursoFuzzy('monay', 30)!;
    expect(r.sql).toContain('fuzzy_jarowin(lower(a.artist), ?)');
    expect(r.sql).toContain('fuzzy_jarowin(lower(a.title), ?)');
    expect(r.args).toEqual(['monay', 'monay', 30]);
  });
  it('returns null for a too-short term (fuzzy would be noise)', () => {
    expect(buildTursoFuzzy('hi')).toBeNull();
  });
});

describe('row-fetchers (injected client — no driver dep)', () => {
  const fake = (rows: Array<Record<string, unknown>>) => ({ execute: vi.fn(async () => ({ rows })) });

  it('tursoFilterRows runs a source-scoped query and passes rows through', async () => {
    const c = fake([{ id: 'aic-1', source: 'aic' }]);
    const rows = await tursoFilterRows('aic', 'monet', { client: c });
    expect(rows).toEqual([{ id: 'aic-1', source: 'aic' }]);
    const arg = c.execute.mock.calls[0][0];
    expect(arg.sql).toContain('a.source = ?');
    expect(arg.args).toContain('aic');
  });
  it('tursoFilterRows returns [] on a degenerate query without calling the client', async () => {
    const c = fake([]);
    expect(await tursoFilterRows('aic', '', { client: c })).toEqual([]);
    expect(c.execute).not.toHaveBeenCalled();
  });
  it('tursoFilterRows propagates client errors (so the fan-out tracks the failure)', async () => {
    const c = { execute: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(tursoFilterRows('aic', 'monet', { client: c })).rejects.toThrow('boom');
  });
  it('tursoFuzzyRows runs the fuzzy fallback', async () => {
    const c = fake([{ id: 'met-9' }]);
    const rows = await tursoFuzzyRows('monay', { client: c });
    expect(rows).toEqual([{ id: 'met-9' }]);
    expect(c.execute.mock.calls[0][0].sql).toContain('fuzzy_jarowin');
  });
});
