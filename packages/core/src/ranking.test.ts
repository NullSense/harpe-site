import { describe, it, expect } from 'vitest';
import { stripHtml, qualityScore, mediumCategory, yearOf } from './ranking';

describe('stripHtml', () => {
  it('removes tags', () => {
    expect(stripHtml('<em>A</em>')).toBe('A');
    expect(stripHtml('a <b>bold</b> <i>word</i>')).toBe('a bold word');
  });
  it('decodes common entities', () => {
    expect(stripHtml('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(stripHtml('he said &quot;hi&quot;')).toBe('he said "hi"');
    expect(stripHtml('it&#39;s')).toBe("it's");
  });
  it('collapses whitespace and handles empty', () => {
    expect(stripHtml('a\n\n  b')).toBe('a b');
    expect(stripHtml('')).toBe('');
  });
});

describe('qualityScore', () => {
  const art = (medium: string, source = 'met', title = 'Untitled') => ({ medium, source, title });

  it('promotes paintings', () => {
    expect(qualityScore(art('Oil on canvas'))).toBeGreaterThan(0);
  });
  it('demotes photographs and prints', () => {
    expect(qualityScore(art('gelatin silver print'))).toBeLessThan(0);
    expect(qualityScore(art('lithograph'))).toBeLessThan(0);
  });
  it('demotes book-catalog records by pagination', () => {
    expect(qualityScore(art('viii, 348 p. illus. 20 cm.'))).toBeLessThan(0);
  });
  it('is query-aware: searching a medium does NOT penalise it', () => {
    const eng = art('engraving');
    expect(qualityScore(eng, '')).toBeLessThan(0);
    expect(qualityScore(eng, 'medieval witch engraving')).toBeGreaterThanOrEqual(0);
  });
  it('does not penalise books when the query asks for one', () => {
    const book = art('348 p. illus.');
    expect(qualityScore(book, '')).toBeLessThan(0);
    expect(qualityScore(book, 'rare book')).toBeGreaterThanOrEqual(qualityScore(book, '') );
  });
  it('downranks aggregator junk (digitalnz)', () => {
    expect(qualityScore(art('', 'digitalnz'))).toBeLessThan(qualityScore(art('', 'met')));
  });
  it('a real painting outranks a photo-of-art for a generic query', () => {
    const painting = qualityScore(art('oil on canvas', 'aic'), 'starry night');
    const photo = qualityScore(art('photograph', 'digitalnz'), 'starry night');
    expect(painting).toBeGreaterThan(photo);
  });
  it('demotes amateur photo-of-artwork variants (tilted / with frame / detail)', () => {
    const clean = art('oil on canvas', 'commons', 'Le Pandemonium by John Martin');
    const tilted = art('oil on canvas', 'commons', 'Le Pandemonium by John Martin (Louvre)-tilted');
    const framed = art('', 'commons', 'Le Pandemonium - John Martin - Louvre - avec cadre');
    expect(qualityScore(tilted, 'john martin painting')).toBeLessThan(qualityScore(clean, 'john martin painting'));
    expect(qualityScore(framed, 'john martin painting')).toBeLessThan(qualityScore(clean, 'john martin painting'));
  });
  it('does NOT demote framing/angle terms when the user wants photos', () => {
    const t = art('photograph', 'commons', 'detail of a fresco');
    expect(qualityScore(t, 'fresco detail photograph')).toBeGreaterThanOrEqual(qualityScore(t, ''));
  });
});

describe('mediumCategory', () => {
  it('classifies common media', () => {
    expect(mediumCategory('Oil on canvas')).toBe('painting');
    expect(mediumCategory('gelatin silver print')).toBe('photo');
    expect(mediumCategory('Lithograph in black')).toBe('print');
    expect(mediumCategory('charcoal and chalk')).toBe('drawing');
    expect(mediumCategory('Bronze, cast')).toBe('sculpture');
    expect(mediumCategory('silk tapestry')).toBe('textile');
    expect(mediumCategory('teapot, porcelain')).toBe('other');
    expect(mediumCategory('')).toBe('other');
  });
});

describe('yearOf', () => {
  it('extracts a year from free text', () => {
    expect(yearOf('1889')).toBe(1889);
    expect(yearOf('ca. 1665')).toBe(1665);
    expect(yearOf('1850-70')).toBe(1850);
    expect(yearOf('c. 1480s')).toBe(1480);
    expect(yearOf('-630')).toBe(-630);
    expect(yearOf('8 x 10 in.')).toBeNull();
    expect(yearOf('')).toBeNull();
  });
});
