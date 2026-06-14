import { describe, it, expect } from 'vitest';
import { stripHtml, qualityScore } from './ranking';

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
});
