/**
 * Tests for the pure picker helpers.
 * No fzf is spawned — only TSV building and selection parsing are exercised.
 * Updated to use ArtItem instead of Candidate (monorepo-phase1 refactor).
 */
import { describe, it, expect } from 'vitest';
import {
  artTsv,
  artRes,
  artSpec,
  parseArtSelection,
  pageTsv,
  parsePageSelection,
  type PageRow,
} from './picker.js';
import type { ArtItem } from '@harpe/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ArtItem> = {}): ArtItem {
  return {
    id: 'test-1',
    title: 'The Night Watch',
    artist: 'Rembrandt',
    dimensions: '363 × 437 cm',
    thumbUrl: 'https://example.org/thumb.jpg',
    previewUrl: 'https://example.org/preview.jpg',
    fullUrl: 'https://example.org/art.jpg',
    width: 1000,
    height: 1000,
    format: 'jpeg',
    lossless: false,
    downloads: [{ label: 'Full', url: 'https://example.org/art.jpg', format: 'jpeg', lossless: false }],
    source: 'vam',
    isPublicDomain: true,
    date: '1642',
    medium: 'oil on canvas',
    description: 'A famous painting',
    ...overrides,
  };
}

const ITEM_A = makeItem({ id: 'a', title: 'A', artist: 'Alpha' });
const ITEM_B = makeItem({ id: 'b', title: 'B', artist: 'Beta', width: 500, height: 500 });
const ITEMS = [ITEM_A, ITEM_B];

// ---------------------------------------------------------------------------
// artRes / artSpec helpers
// ---------------------------------------------------------------------------
describe('artRes', () => {
  it('returns WxH string when width and height are present', () => {
    expect(artRes(makeItem({ width: 1200, height: 800 }))).toBe('1200x800');
  });

  it('returns empty string when dimensions are absent', () => {
    expect(artRes(makeItem({ width: undefined, height: undefined }))).toBe('');
  });

  it('returns empty string when width is 0', () => {
    expect(artRes(makeItem({ width: 0, height: 800 }))).toBe('');
  });
});

describe('artSpec', () => {
  it('returns fullUrl', () => {
    const it = makeItem({ fullUrl: 'https://example.org/full.jpg' });
    expect(artSpec(it)).toBe('https://example.org/full.jpg');
  });
});

// ---------------------------------------------------------------------------
// artTsv
// ---------------------------------------------------------------------------
describe('artTsv', () => {
  it('returns one line per item', () => {
    const lines = artTsv(ITEMS);
    expect(lines).toHaveLength(2);
  });

  it('first field is the 0-based index', () => {
    const lines = artTsv(ITEMS);
    expect(lines[0]!.startsWith('0\t')).toBe(true);
    expect(lines[1]!.startsWith('1\t')).toBe(true);
  });

  it('fields are tab-separated with the correct order', () => {
    const [line] = artTsv([ITEM_A]);
    const fields = line!.split('\t');
    // 0=index 1=res 2=source 3=title 4=artist 5=date 6=spec 7=thumb 8=medium 9=desc 10=physdim
    expect(fields[0]).toBe('0');
    expect(fields[1]).toBe(artRes(ITEM_A));    // '1000x1000'
    expect(fields[2]).toBe(ITEM_A.source);    // 'vam'
    expect(fields[3]).toBe(ITEM_A.title);     // 'A'
    expect(fields[4]).toBe(ITEM_A.artist);    // 'Alpha'
    expect(fields[5]).toBe(ITEM_A.date);      // '1642'
    expect(fields[6]).toBe(ITEM_A.fullUrl);   // 'https://example.org/art.jpg'
    expect(fields[7]).toBe(ITEM_A.thumbUrl);  // 'https://example.org/thumb.jpg'
    expect(fields[8]).toBe(ITEM_A.medium);    // 'oil on canvas'
    expect(fields[9]).toBe(ITEM_A.description); // 'A famous painting'
    expect(fields[10]).toBe(ITEM_A.dimensions); // '363 × 437 cm'
  });

  it('sanitises tabs and newlines inside field values', () => {
    const c = makeItem({ title: 'Tab\there', description: 'Line\nOne\rTwo' });
    const [line] = artTsv([c]);
    expect(line).not.toMatch(/\r/);
    // should not have extra field splits due to embedded tab
    const fields = line!.split('\t');
    expect(fields).toHaveLength(11);
  });

  it('returns empty array for empty input', () => {
    expect(artTsv([])).toEqual([]);
  });

  it('uses empty string for optional fields when absent', () => {
    const c = makeItem({ date: undefined, medium: undefined, description: undefined });
    const [line] = artTsv([c]);
    const fields = line!.split('\t');
    expect(fields[5]).toBe('');  // date
    expect(fields[8]).toBe('');  // medium
    expect(fields[9]).toBe('');  // description
  });
});

// ---------------------------------------------------------------------------
// parseArtSelection
// ---------------------------------------------------------------------------
describe('parseArtSelection', () => {
  it('resolves a valid line back to the item', () => {
    const lines = artTsv(ITEMS);
    expect(parseArtSelection(lines[0]!, ITEMS)).toBe(ITEM_A);
    expect(parseArtSelection(lines[1]!, ITEMS)).toBe(ITEM_B);
  });

  it('returns null for an empty line', () => {
    expect(parseArtSelection('', ITEMS)).toBeNull();
    expect(parseArtSelection('   ', ITEMS)).toBeNull();
  });

  it('returns null when the index is out of range', () => {
    expect(parseArtSelection('99\tres\tsrc', ITEMS)).toBeNull();
  });

  it('returns null for a non-numeric first field', () => {
    expect(parseArtSelection('NaN\tres\tsrc', ITEMS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pageTsv
// ---------------------------------------------------------------------------
describe('pageTsv', () => {
  const ROWS: PageRow[] = [
    { dim: '2048×2048', url: 'https://a.example/img.jpg', name: 'Image A' },
    { dim: '800×600', url: 'https://b.example/img.jpg', name: 'Image B' },
  ];

  it('returns one line per row', () => {
    expect(pageTsv(ROWS)).toHaveLength(2);
  });

  it('fields are tab-separated in dim/url/name order', () => {
    const [line] = pageTsv([ROWS[0]!]);
    const fields = line!.split('\t');
    expect(fields[0]).toBe('2048×2048');
    expect(fields[1]).toBe('https://a.example/img.jpg');
    expect(fields[2]).toBe('Image A');
  });

  it('sanitises embedded control characters', () => {
    const rows: PageRow[] = [{ dim: '100×100', url: 'https://x.com/a', name: 'A\tB\nC' }];
    const [line] = pageTsv(rows);
    const fields = line!.split('\t');
    expect(fields).toHaveLength(3);
    expect(fields[2]).toBe('A B C');
  });

  it('returns empty array for empty input', () => {
    expect(pageTsv([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parsePageSelection
// ---------------------------------------------------------------------------
describe('parsePageSelection', () => {
  it('parses multi-select output lines to {url, name}', () => {
    const input = [
      '2048×2048\thttps://a.example/img.jpg\tImage A',
      '800×600\thttps://b.example/img.jpg\tImage B',
    ];
    const result = parsePageSelection(input);
    expect(result).toEqual([
      { url: 'https://a.example/img.jpg', name: 'Image A' },
      { url: 'https://b.example/img.jpg', name: 'Image B' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parsePageSelection([])).toEqual([]);
  });

  it('skips lines with fewer than 2 fields', () => {
    expect(parsePageSelection(['onlyone'])).toEqual([]);
  });

  it('handles missing name field gracefully (uses empty string)', () => {
    const result = parsePageSelection(['800×600\thttps://example.org/img.jpg']);
    expect(result).toEqual([{ url: 'https://example.org/img.jpg', name: '' }]);
  });
});
