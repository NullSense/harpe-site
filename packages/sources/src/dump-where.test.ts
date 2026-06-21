import { describe, it, expect } from 'vitest';
import { dumpWhere } from './adapters.js';

// The HF /filter WHERE that drives per-source dump queries. Grammar validated live:
// columns in double quotes, ILIKE, AND/OR/parens. Artist must contain EVERY query
// token; title/depicts match the whole phrase.
describe('dumpWhere', () => {
  it('scopes to the source and ANDs every artist token', () => {
    const w = dumpWhere('met', 'Rembrandt van Rijn')!;
    expect(w).not.toBeNull();
    expect(w.startsWith(`"source"='met' AND (`)).toBe(true);
    expect(w).toContain(`"artist" ILIKE '%rembrandt%'`);
    expect(w).toContain(`"artist" ILIKE '%van%'`);
    expect(w).toContain(`"artist" ILIKE '%rijn%'`);
    // …AND-joined, not OR
    expect(w).toContain(`'%rembrandt%' AND "artist" ILIKE '%van%'`);
  });
  it('also matches title and depicts on the whole phrase', () => {
    const w = dumpWhere('nga', 'great red dragon')!;
    expect(w).toContain(`"title" ILIKE '%great red dragon%'`);
    expect(w).toContain(`"depicts_labels" ILIKE '%great red dragon%'`);
  });
  it('matches depicts_qids for a bare QID query (subject pages — /api/depicts)', () => {
    // Regression: /api/depicts?qid=Q7226 ("Joan of Arc") must hit the depicts_QIDS
    // column. Before this, only depicts_labels was searched (human labels, never a
    // QID) → every subject page returned 0 works despite a positive workCount.
    const w = dumpWhere('wikidata', 'Q7226')!;
    expect(w).toContain(`"depicts_qids" ILIKE '%q7226%'`);
  });
  it('does NOT add a depicts_qids clause for a normal text query', () => {
    const w = dumpWhere('met', 'Joan of Arc')!;
    expect(w).not.toContain('"depicts_qids"'); // only for bare QIDs
  });
  it('returns null for an all-wildcard query (no match-all scan)', () => {
    expect(dumpWhere('met', '%%')).toBeNull();
    expect(dumpWhere('met', '% _')).toBeNull();
    expect(dumpWhere('met', '   ')).toBeNull();
  });
  it("escapes single quotes to prevent breaking the clause (O'Keeffe)", () => {
    const w = dumpWhere('met', "O'Keeffe");
    expect(w).toContain(`'%o''keeffe%'`); // doubled quote
    expect(w).not.toContain(`%o'keeffe%`); // never a raw lone quote inside the literal
  });
  it('strips ILIKE wildcards from user input so they cannot widen the match', () => {
    const w = dumpWhere('aic', 'mona %_lisa');
    expect(w).not.toContain('%_lisa');
    expect(w).toContain(`"artist" ILIKE '%mona%'`);
    expect(w).toContain(`"artist" ILIKE '%lisa%'`);
  });
});

describe('dumpWhere — QID-backed facet filters', () => {
  it('ANDs an artist_qid facet (case-insensitive exact) onto a text query', () => {
    const w = dumpWhere('aic', 'water lilies', { artistQid: 'Q296' })!;
    expect(w.startsWith(`"source"='aic' AND (`)).toBe(true);
    expect(w).toContain(`AND "artist_qid" ILIKE 'Q296'`); // no wildcards → exact, case-insensitive
  });
  it('ANDs a depicts_qids facet (substring prefilter on the space-joined column)', () => {
    const w = dumpWhere('aic', 'landscape', { depictsQid: 'Q7569' })!;
    expect(w).toContain(`AND "depicts_qids" ILIKE '%Q7569%'`);
  });
  it('ANDs a movement facet (substring)', () => {
    const w = dumpWhere('aic', 'landscape', { movement: 'Impressionism' })!;
    expect(w).toContain(`AND "movement" ILIKE '%impressionism%'`);
  });
  it('supports a facet-only query (no text) — e.g. every work depicting a subject', () => {
    expect(dumpWhere('aic', '', { depictsQid: 'Q7569' })).toBe(`"source"='aic' AND "depicts_qids" ILIKE '%Q7569%'`);
  });
  it('combines multiple facets', () => {
    const w = dumpWhere('aic', '', { artistQid: 'Q296', movement: 'Impressionism' })!;
    expect(w).toContain(`"artist_qid" ILIKE 'Q296'`);
    expect(w).toContain(`"movement" ILIKE '%impressionism%'`);
  });
  it('ignores an invalid QID facet (null when no text and no valid facet)', () => {
    expect(dumpWhere('aic', '', { artistQid: 'not-a-qid' })).toBeNull();
  });
  it('escapes quotes in a movement facet', () => {
    const w = dumpWhere('aic', '', { movement: "art o'clock" })!;
    expect(w).toContain(`'%art o''clock%'`);
  });
});
