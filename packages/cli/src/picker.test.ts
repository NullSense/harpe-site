/**
 * Tests for the pure picker helpers.
 * No fzf is spawned — only TSV building and selection parsing are exercised.
 */
import { describe, it, expect } from 'vitest';
import {
  artTsv,
  parseArtSelection,
  pageTsv,
  parsePageSelection,
  type PageRow,
} from './picker';
import type { Candidate } from './models';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCand(overrides: Partial<Candidate> = {}): Candidate {
  return {
    area: 1000000,
    res: '1000×1000',
    source: 'rijksmuseum',
    title: 'The Night Watch',
    artist: 'Rembrandt',
    date: '1642',
    spec: 'url:https://example.org/art.jpg',
    thumb: 'https://example.org/thumb.jpg',
    medium: 'oil on canvas',
    desc: 'A famous painting',
    physdim: '363×437 cm',
    ...overrides,
  };
}

const CAND_A = makeCand({ title: 'A', artist: 'Alpha' });
const CAND_B = makeCand({ title: 'B', artist: 'Beta', res: '500×500' });
const CANDS = [CAND_A, CAND_B];

// ---------------------------------------------------------------------------
// artTsv
// ---------------------------------------------------------------------------
describe('artTsv', () => {
  it('returns one line per candidate', () => {
    const lines = artTsv(CANDS);
    expect(lines).toHaveLength(2);
  });

  it('first field is the 0-based index', () => {
    const lines = artTsv(CANDS);
    expect(lines[0]!.startsWith('0\t')).toBe(true);
    expect(lines[1]!.startsWith('1\t')).toBe(true);
  });

  it('fields are tab-separated with the correct order', () => {
    const [line] = artTsv([CAND_A]);
    const fields = line!.split('\t');
    // 0=index 1=res 2=source 3=title 4=artist 5=date 6=spec 7=thumb 8=medium 9=desc 10=physdim
    expect(fields[0]).toBe('0');
    expect(fields[1]).toBe(CAND_A.res);
    expect(fields[2]).toBe(CAND_A.source);
    expect(fields[3]).toBe(CAND_A.title);
    expect(fields[4]).toBe(CAND_A.artist);
    expect(fields[5]).toBe(CAND_A.date);
    expect(fields[6]).toBe(CAND_A.spec);
    expect(fields[7]).toBe(CAND_A.thumb);
    expect(fields[8]).toBe(CAND_A.medium);
    expect(fields[9]).toBe(CAND_A.desc);
    expect(fields[10]).toBe(CAND_A.physdim);
  });

  it('sanitises tabs and newlines inside field values', () => {
    const c = makeCand({ title: 'Tab\there', desc: 'Line\nOne\rTwo' });
    const [line] = artTsv([c]);
    expect(line).not.toMatch(/\r/);
    // should not have extra field splits due to embedded tab
    const fields = line!.split('\t');
    expect(fields).toHaveLength(11);
  });

  it('returns empty array for empty input', () => {
    expect(artTsv([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseArtSelection
// ---------------------------------------------------------------------------
describe('parseArtSelection', () => {
  it('resolves a valid line back to the candidate', () => {
    const lines = artTsv(CANDS);
    expect(parseArtSelection(lines[0]!, CANDS)).toBe(CAND_A);
    expect(parseArtSelection(lines[1]!, CANDS)).toBe(CAND_B);
  });

  it('returns null for an empty line', () => {
    expect(parseArtSelection('', CANDS)).toBeNull();
    expect(parseArtSelection('   ', CANDS)).toBeNull();
  });

  it('returns null when the index is out of range', () => {
    expect(parseArtSelection('99\tres\tsrc', CANDS)).toBeNull();
  });

  it('returns null for a non-numeric first field', () => {
    expect(parseArtSelection('NaN\tres\tsrc', CANDS)).toBeNull();
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
