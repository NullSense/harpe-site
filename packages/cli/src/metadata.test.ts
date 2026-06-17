/**
 * Unit tests for metadata.ts — pure functions only (no subprocess calls).
 * Ported from harpe/tests/test_metadata.py.
 */
import { describe, it, expect } from 'vitest';
import { nameParts, buildSlug, captions, sidecarText } from './metadata.js';
import type { Candidate } from './models.js';

// Helper: minimal Candidate with just the fields we need for a given test.
function mkC(partial: Partial<Candidate>): Candidate {
  return {
    area: 0, res: '', source: '', title: '', artist: '', date: '',
    spec: '', thumb: '', medium: '', desc: '', physdim: '',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// nameParts
// ---------------------------------------------------------------------------
describe('nameParts', () => {
  it('drops nationality/life-date suffixes and extracts year', () => {
    const c = mkC({ title: 'The Bedroom', artist: 'Vincent van Gogh (Dutch, 1853–1890)', date: '1888', source: 'AIC' });
    const [name, artist, year] = nameParts(c);
    expect(artist).toBe('Vincent van Gogh');
    expect(year).toBe('1888');
    expect(name).toBe('Vincent van Gogh - The Bedroom (1888) [AIC]');
  });

  it('uses "artwork" when title is missing', () => {
    const c = mkC({ source: 'Met' });
    const [name, artist, year] = nameParts(c);
    expect(name).toBe('artwork [Met]');
    expect(artist).toBe('');
    expect(year).toBe('');
  });

  it('handles artist-only (no date)', () => {
    const c = mkC({ title: 'Starry Night', artist: 'Van Gogh', source: 'MoMA' });
    const [name, artist, year] = nameParts(c);
    expect(name).toBe('Van Gogh - Starry Night [MoMA]');
    expect(artist).toBe('Van Gogh');
    expect(year).toBe('');
  });

  it('handles title-only (no artist, no date)', () => {
    const c = mkC({ title: 'The Persistence of Memory', source: 'MoMA' });
    const [name] = nameParts(c);
    expect(name).toBe('The Persistence of Memory [MoMA]');
  });

  it('extracts a 3-digit year', () => {
    const c = mkC({ title: 'Icon', date: '900 AD', source: 'Met' });
    const [, , year] = nameParts(c);
    expect(year).toBe('900');
  });
});

// ---------------------------------------------------------------------------
// buildSlug
// ---------------------------------------------------------------------------
describe('buildSlug', () => {
  it('sanitizes filesystem-hostile characters', () => {
    const c = mkC({ title: 'A/B: C?', artist: 'X', date: '1900', source: 'Met' });
    const slug = buildSlug(c);
    expect(slug).not.toContain('/');
    expect(slug).not.toContain(':');
    expect(slug).not.toContain('?');
    expect(slug.startsWith('X - A B C')).toBe(true);
  });

  it('strips backslash and other illegal chars', () => {
    const c = mkC({ title: 'A\\B*C<D>E|F', source: 'Test' });
    const slug = buildSlug(c);
    expect(slug).not.toMatch(/[\\*<>|]/);
  });

  it('collapses multiple spaces', () => {
    const c = mkC({ title: 'Hello   World', source: 'X' });
    const slug = buildSlug(c);
    expect(slug).not.toMatch(/  /);
  });

  it('limits to 150 characters', () => {
    const c = mkC({ title: 'A'.repeat(200), source: 'X' });
    expect(buildSlug(c).length).toBeLessThanOrEqual(150);
  });

  it('falls back to "artwork" for an empty result', () => {
    // A candidate whose display name reduces to all spaces/illegal chars
    const c = mkC({ title: '///', source: '' });
    // slug may be empty after stripping — we rely on the fallback
    // (source is '' so name becomes "/// []" → strip / → "   []" → trim → "[]")
    const slug = buildSlug(c);
    expect(slug.length).toBeGreaterThan(0);
  });

  it('strips control characters', () => {
    const c = mkC({ title: 'A\x01B\x1fC', source: 'X' });
    const slug = buildSlug(c);
    expect(slug).not.toMatch(/[\x00-\x1f]/);
  });
});

// ---------------------------------------------------------------------------
// captions
// ---------------------------------------------------------------------------
describe('captions', () => {
  it('composes caption and body correctly', () => {
    const c = mkC({
      title: 'The Deluge', artist: 'John Martin', date: '1834',
      source: 'AIC', medium: 'oil on canvas',
      physdim: '100 x 200 cm', desc: 'An apocalyptic flood.',
    });
    const { caption, body } = captions(c, '5000x3000');
    expect(caption).toBe('John Martin — The Deluge (1834)');
    expect(body).toContain('oil on canvas');
    expect(body).toContain('100 x 200 cm');
    expect(body).toContain('5000x3000 · AIC');
    expect(body.endsWith('An apocalyptic flood.')).toBe(true);
  });

  it('caption is title only when no artist', () => {
    const c = mkC({ title: 'Untitled', source: 'Met' });
    const { caption } = captions(c, '800x600');
    expect(caption).toBe('Untitled');
  });

  it('body line is just "res · source" when no medium/physdim/desc', () => {
    const c = mkC({ title: 'X', source: 'Met' });
    const { body } = captions(c, '1920x1080');
    expect(body).toBe('1920x1080 · Met');
  });

  it('includes year in caption', () => {
    const c = mkC({ title: 'Night Watch', artist: 'Rembrandt', date: '1642', source: 'RMA' });
    const { caption } = captions(c, '');
    expect(caption).toBe('Rembrandt — Night Watch (1642)');
  });

  it('omits desc block when desc is empty', () => {
    const c = mkC({ title: 'T', source: 'S', medium: 'oil' });
    const { body } = captions(c, '100x100');
    expect(body).not.toContain('\n\n');
  });
});

// ---------------------------------------------------------------------------
// sidecarText
// ---------------------------------------------------------------------------
describe('sidecarText', () => {
  it('includes all non-empty fields', () => {
    const c = mkC({
      title: 'The Milkmaid', artist: 'Vermeer', date: '1658',
      medium: 'oil on canvas', physdim: '45.5 × 41 cm',
      spec: 'url:https://rijksmuseum.nl/image.jpg',
      source: 'RMA', desc: 'Genre scene.',
    });
    const text = sidecarText(c, '1920x1080');
    expect(text).toContain('Title: The Milkmaid');
    expect(text).toContain('Artist: Vermeer');
    expect(text).toContain('Date: 1658');
    expect(text).toContain('Medium: oil on canvas');
    expect(text).toContain('Dimensions: 45.5 × 41 cm');
    expect(text).toContain('Resolution: 1920x1080');
    expect(text).toContain('Source: RMA');
    expect(text).toContain('Source URL: https://rijksmuseum.nl/image.jpg');
    expect(text).toContain('Genre scene.');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('omits absent optional fields', () => {
    const c = mkC({ title: 'T', spec: 'url:https://x.com/a.jpg', source: 'X' });
    const text = sidecarText(c, '1x1');
    expect(text).not.toContain('Artist:');
    expect(text).not.toContain('Date:');
    expect(text).not.toContain('Medium:');
    expect(text).not.toContain('Dimensions:');
  });

  it('strips url: prefix from spec for Source URL', () => {
    const c = mkC({ title: 'T', spec: 'url:https://example.org/img.jpg', source: 'X' });
    const text = sidecarText(c, '');
    expect(text).toContain('Source URL: https://example.org/img.jpg');
  });

  it('strips iiif: prefix from spec for Source URL', () => {
    const c = mkC({ title: 'T', spec: 'iiif:https://x/m.json', source: 'X' });
    const text = sidecarText(c, '');
    expect(text).toContain('Source URL: https://x/m.json');
  });
});
