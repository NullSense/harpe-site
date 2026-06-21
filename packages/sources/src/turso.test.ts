import { describe, it, expect } from 'vitest';
import { buildTursoSearch, ftsMatch } from './turso.js';

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
  it('ANDs an artist_qid facet (exact, parameterized) in the right arg order', () => {
    const r = buildTursoSearch('water lilies', { facets: { artistQid: 'q296' } })!;
    expect(r.sql).toContain('MATCH ? AND a.artist_qid = ?');
    expect(r.args).toEqual(['"water"* "lilies"*', 'Q296', 100]); // QID upper-cased, default limit
  });
  it('ANDs a depicts_qids facet as a LIKE substring', () => {
    const r = buildTursoSearch('landscape', { facets: { depictsQid: 'Q7569' } })!;
    expect(r.sql).toContain('AND a.depicts_qids LIKE ?');
    expect(r.args).toEqual(['"landscape"*', '%Q7569%', 100]);
  });
  it('ANDs a movement facet as a LIKE substring', () => {
    const r = buildTursoSearch('landscape', { facets: { movement: 'Impressionism' } })!;
    expect(r.args).toEqual(['"landscape"*', '%Impressionism%', 100]);
  });
  it('supports a facet-only query (no text) without an FTS MATCH', () => {
    const r = buildTursoSearch('', { facets: { depictsQid: 'Q7569' }, limit: 50 })!;
    expect(r.sql).toBe('SELECT a.id, a.source, a.title, a.artist, a.date, a.medium, a.image_thumb, a.image_full, a.width, a.height, a.source_url, a.is_public_domain, a.wikidata_qid, a.artist_qid, a.depicts_qids, a.depicts_labels, a.movement FROM art a WHERE a.depicts_qids LIKE ? LIMIT ?');
    expect(r.args).toEqual(['%Q7569%', 50]);
  });
  it('returns null for a degenerate query (no text, no valid facet) — no match-all scan', () => {
    expect(buildTursoSearch('')).toBeNull();
    expect(buildTursoSearch('', { facets: { artistQid: 'not-a-qid' } })).toBeNull();
  });
  it('clamps the limit to [1, 500]', () => {
    expect(buildTursoSearch('x art', { limit: 9999 })!.args.at(-1)).toBe(500);
    expect(buildTursoSearch('x art', { limit: 0 })!.args.at(-1)).toBe(1);
  });
});
