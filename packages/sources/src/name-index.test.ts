import { describe, it, expect } from 'vitest';
import { buildNameIndex, resolveArtistQid } from './adapters.js';

// The artist name→QID matching is the single source of truth (ingest emits only
// raw {name: QID}; ALL normalization/suffix/collision logic lives here).

describe('buildNameIndex + resolveArtistQid', () => {
  const idx = buildNameIndex({
    'Vincent van Gogh': 'Q5582',
    'Claude Monet': 'Q41406',
    'Auguste Rodin': 'Q34618',
    '齐白石': 'Q5602',           // non-Latin → normalize() empties → keyed raw
    'John Smith': 'Q100',        // colliding surname…
    'Jane Smith': 'Q200',        // …with this one → "smith" dropped
  });

  it('matches the full name (diacritic- and case-insensitive)', () => {
    expect(resolveArtistQid(idx, 'Vincent van Gogh')).toBe('Q5582');
    expect(resolveArtistQid(idx, 'CLAUDE MONET')).toBe('Q41406');
    expect(resolveArtistQid(idx, 'Augusté  Rodin')).toBe('Q34618'); // accent + extra space
  });

  it('matches a ≥4-char surname suffix', () => {
    expect(resolveArtistQid(idx, 'van Gogh')).toBe('Q5582');
    expect(resolveArtistQid(idx, 'Monet')).toBe('Q41406');
    expect(resolveArtistQid(idx, 'Rodin')).toBe('Q34618');
  });

  it('drops a surname shared by >1 artist (no wrong-person merge)', () => {
    expect(resolveArtistQid(idx, 'Smith')).toBeUndefined();
    expect(resolveArtistQid(idx, 'John Smith')).toBe('Q100'); // full name still resolves
  });

  it('resolves non-Latin names via the raw key', () => {
    expect(resolveArtistQid(idx, '齐白石')).toBe('Q5602');
  });

  it('returns undefined for unknown / empty', () => {
    expect(resolveArtistQid(idx, 'Nobody McNobody')).toBeUndefined();
    expect(resolveArtistQid(idx, '')).toBeUndefined();
  });

  it('ignores malformed QIDs in the raw map', () => {
    expect(resolveArtistQid(buildNameIndex({ 'X Y': 'not-a-qid' }), 'X Y')).toBeUndefined();
  });
});
