import { describe, it, expect } from 'vitest';
import { dumpWhere } from './adapters.js';

// The HF /filter WHERE that drives per-source dump queries. Grammar validated live:
// columns in double quotes, ILIKE, AND/OR/parens. Artist must contain EVERY query
// token; title/depicts match the whole phrase.
describe('dumpWhere', () => {
  it('scopes to the source and ANDs every artist token', () => {
    const w = dumpWhere('met', 'Rembrandt van Rijn');
    expect(w.startsWith(`"source"='met' AND (`)).toBe(true);
    expect(w).toContain(`"artist" ILIKE '%rembrandt%'`);
    expect(w).toContain(`"artist" ILIKE '%van%'`);
    expect(w).toContain(`"artist" ILIKE '%rijn%'`);
    // …AND-joined, not OR
    expect(w).toContain(`'%rembrandt%' AND "artist" ILIKE '%van%'`);
  });
  it('also matches title and depicts on the whole phrase', () => {
    const w = dumpWhere('nga', 'great red dragon');
    expect(w).toContain(`"title" ILIKE '%great red dragon%'`);
    expect(w).toContain(`"depicts_labels" ILIKE '%great red dragon%'`);
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
