/**
 * Unit tests for metadata.ts — pure functions only (no subprocess calls).
 * Ported from harpe/tests/test_metadata.py.
 * Updated to use ArtItem instead of Candidate (monorepo-phase1 refactor).
 */
import { describe, it, expect } from 'vitest';
import { nameParts, buildSlug, captions, sidecarText } from './metadata.js';
import type { ArtItem } from '@harpe/core';

// Helper: minimal ArtItem with just the fields we need for a given test.
function mkItem(partial: Partial<ArtItem>): ArtItem {
  return {
    id: 'test',
    title: '',
    artist: '',
    dimensions: '',
    thumbUrl: '',
    previewUrl: '',
    fullUrl: 'https://example.org/art.jpg',
    format: 'jpeg',
    lossless: false,
    downloads: [],
    source: 'aic',
    isPublicDomain: true,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// nameParts
// ---------------------------------------------------------------------------
describe('nameParts', () => {
  it('drops nationality/life-date suffixes and extracts year', () => {
    const it = mkItem({ title: 'The Bedroom', artist: 'Vincent van Gogh (Dutch, 1853–1890)', date: '1888', source: 'aic' });
    const [name, artist, year] = nameParts(it);
    expect(artist).toBe('Vincent van Gogh');
    expect(year).toBe('1888');
    expect(name).toBe('Vincent van Gogh - The Bedroom (1888) [aic]');
  });

  it('uses "artwork" when title is missing', () => {
    const it = mkItem({ source: 'met' });
    const [name, artist, year] = nameParts(it);
    expect(name).toBe('artwork [met]');
    expect(artist).toBe('');
    expect(year).toBe('');
  });

  it('handles artist-only (no date)', () => {
    const it = mkItem({ title: 'Starry Night', artist: 'Van Gogh', source: 'moma' });
    const [name, artist, year] = nameParts(it);
    expect(name).toBe('Van Gogh - Starry Night [moma]');
    expect(artist).toBe('Van Gogh');
    expect(year).toBe('');
  });

  it('handles title-only (no artist, no date)', () => {
    const it = mkItem({ title: 'The Persistence of Memory', source: 'moma' });
    const [name] = nameParts(it);
    expect(name).toBe('The Persistence of Memory [moma]');
  });

  it('extracts a 3-digit year', () => {
    const it = mkItem({ title: 'Icon', date: '900 AD', source: 'met' });
    const [, , year] = nameParts(it);
    expect(year).toBe('900');
  });
});

// ---------------------------------------------------------------------------
// buildSlug
// ---------------------------------------------------------------------------
describe('buildSlug', () => {
  it('sanitizes filesystem-hostile characters', () => {
    const it = mkItem({ title: 'A/B: C?', artist: 'X', date: '1900', source: 'met' });
    const slug = buildSlug(it);
    expect(slug).not.toContain('/');
    expect(slug).not.toContain(':');
    expect(slug).not.toContain('?');
    expect(slug.startsWith('X - A B C')).toBe(true);
  });

  it('strips backslash and other illegal chars', () => {
    const it = mkItem({ title: 'A\\B*C<D>E|F', source: 'aic' });
    const slug = buildSlug(it);
    expect(slug).not.toMatch(/[\\*<>|]/);
  });

  it('collapses multiple spaces', () => {
    const it = mkItem({ title: 'Hello   World', source: 'aic' });
    const slug = buildSlug(it);
    expect(slug).not.toMatch(/  /);
  });

  it('limits to 150 characters', () => {
    const it = mkItem({ title: 'A'.repeat(200), source: 'aic' });
    expect(buildSlug(it).length).toBeLessThanOrEqual(150);
  });

  it('falls back to "artwork" for an empty result', () => {
    // A candidate whose display name reduces to all spaces/illegal chars
    const it = mkItem({ title: '///', source: '' as ArtItem['source'] });
    const slug = buildSlug(it);
    expect(slug.length).toBeGreaterThan(0);
  });

  it('strips control characters', () => {
    const it = mkItem({ title: 'A\x01B\x1fC', source: 'aic' });
    const slug = buildSlug(it);
    expect(slug).not.toMatch(/[\x00-\x1f]/);
  });
});

// ---------------------------------------------------------------------------
// captions
// ---------------------------------------------------------------------------
describe('captions', () => {
  it('composes caption and body correctly', () => {
    const it = mkItem({
      title: 'The Deluge', artist: 'John Martin', date: '1834',
      source: 'aic', medium: 'oil on canvas',
      dimensions: '100 x 200 cm', description: 'An apocalyptic flood.',
    });
    const { caption, body } = captions(it, '5000x3000');
    expect(caption).toBe('John Martin — The Deluge (1834)');
    expect(body).toContain('oil on canvas');
    expect(body).toContain('100 x 200 cm');
    expect(body).toContain('5000x3000 · aic');
    expect(body.endsWith('An apocalyptic flood.')).toBe(true);
  });

  it('caption is title only when no artist', () => {
    const it = mkItem({ title: 'Untitled', source: 'met' });
    const { caption } = captions(it, '800x600');
    expect(caption).toBe('Untitled');
  });

  it('body line is just "res · source" when no medium/dimensions/description', () => {
    const it = mkItem({ title: 'X', source: 'met' });
    const { body } = captions(it, '1920x1080');
    expect(body).toBe('1920x1080 · met');
  });

  it('includes year in caption', () => {
    const it = mkItem({ title: 'Night Watch', artist: 'Rembrandt', date: '1642', source: 'vam' });
    const { caption } = captions(it, '');
    expect(caption).toBe('Rembrandt — Night Watch (1642)');
  });

  it('omits description block when description is empty', () => {
    const it = mkItem({ title: 'T', source: 'aic', medium: 'oil' });
    const { body } = captions(it, '100x100');
    expect(body).not.toContain('\n\n');
  });
});

// ---------------------------------------------------------------------------
// sidecarText
// ---------------------------------------------------------------------------
describe('sidecarText', () => {
  it('includes all non-empty fields', () => {
    const it = mkItem({
      title: 'The Milkmaid', artist: 'Vermeer', date: '1658',
      medium: 'oil on canvas', dimensions: '45.5 × 41 cm',
      sourceUrl: 'https://rijksmuseum.nl/image.jpg',
      fullUrl: 'https://rijksmuseum.nl/image.jpg',
      source: 'vam', description: 'Genre scene.',
    });
    const text = sidecarText(it, '1920x1080');
    expect(text).toContain('Title: The Milkmaid');
    expect(text).toContain('Artist: Vermeer');
    expect(text).toContain('Date: 1658');
    expect(text).toContain('Medium: oil on canvas');
    expect(text).toContain('Dimensions: 45.5 × 41 cm');
    expect(text).toContain('Resolution: 1920x1080');
    expect(text).toContain('Source: vam');
    expect(text).toContain('Source URL: https://rijksmuseum.nl/image.jpg');
    expect(text).toContain('Genre scene.');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('omits absent optional fields', () => {
    const it = mkItem({ title: 'T', source: 'aic' });
    const text = sidecarText(it, '1x1');
    expect(text).not.toContain('Artist:');
    expect(text).not.toContain('Date:');
    expect(text).not.toContain('Medium:');
    expect(text).not.toContain('Dimensions:');
  });

  it('uses sourceUrl as the Source URL field when present', () => {
    const it = mkItem({ title: 'T', sourceUrl: 'https://museum.org/work/123', source: 'aic' });
    const text = sidecarText(it, '');
    expect(text).toContain('Source URL: https://museum.org/work/123');
  });

  it('falls back to fullUrl when sourceUrl is absent', () => {
    const it = mkItem({ title: 'T', fullUrl: 'https://example.org/img.jpg', source: 'aic' });
    const text = sidecarText(it, '');
    expect(text).toContain('Source URL: https://example.org/img.jpg');
  });

  // --- new fields ---

  it('includes new fields when all are present', () => {
    const it = mkItem({
      title: 'Starry Night', artist: 'Van Gogh', source: 'moma',
      accessionNumber: 'MoMA-472.1941',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      tags: ['post-impressionism', 'night', 'swirling'],
      artworkType: 'Painting',
      style: 'Post-Impressionism',
      inscriptions: 'Vincent [lower left]',
    });
    const text = sidecarText(it, '2400x1920');
    expect(text).toContain('Accession Number: MoMA-472.1941');
    expect(text).toContain('License: https://creativecommons.org/licenses/by/4.0/');
    expect(text).toContain('Tags: post-impressionism, night, swirling');
    expect(text).toContain('Type: Painting');
    expect(text).toContain('Style: Post-Impressionism');
    expect(text).toContain('Inscriptions: Vincent [lower left]');
  });

  it('omits new fields when all are absent', () => {
    const it = mkItem({ title: 'Untitled', source: 'met' });
    const text = sidecarText(it, '1x1');
    expect(text).not.toContain('Accession Number:');
    expect(text).not.toContain('License:');
    expect(text).not.toContain('Tags:');
    expect(text).not.toContain('Type:');
    expect(text).not.toContain('Style:');
    expect(text).not.toContain('Inscriptions:');
  });

  it('omits Tags line when tags array is empty', () => {
    const it = mkItem({ title: 'T', source: 'aic', tags: [] });
    const text = sidecarText(it, '');
    expect(text).not.toContain('Tags:');
  });

  it('includes each new field independently — licenseUrl only', () => {
    const it = mkItem({ title: 'T', source: 'aic', licenseUrl: 'https://example.com/cc0' });
    const text = sidecarText(it, '');
    expect(text).toContain('License: https://example.com/cc0');
    expect(text).not.toContain('Accession Number:');
    expect(text).not.toContain('Tags:');
  });

  it('includes each new field independently — accessionNumber only', () => {
    const it = mkItem({ title: 'T', source: 'aic', accessionNumber: 'AIC-1234' });
    const text = sidecarText(it, '');
    expect(text).toContain('Accession Number: AIC-1234');
    expect(text).not.toContain('License:');
  });

  it('includes each new field independently — tags only', () => {
    const it = mkItem({ title: 'T', source: 'aic', tags: ['landscape', 'watercolor'] });
    const text = sidecarText(it, '');
    expect(text).toContain('Tags: landscape, watercolor');
  });

  it('inscriptions appears after description block', () => {
    const it = mkItem({
      title: 'Icon', source: 'met',
      description: 'Byzantine icon.',
      inscriptions: 'IC XC (top corners)',
    });
    const text = sidecarText(it, '');
    const descIdx = text.indexOf('Byzantine icon.');
    const inscIdx = text.indexOf('Inscriptions:');
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(inscIdx).toBeGreaterThan(descIdx);
  });

  it('inscriptions appears without description when description is absent', () => {
    const it = mkItem({ title: 'T', source: 'aic', inscriptions: 'Signed lower right' });
    const text = sidecarText(it, '');
    expect(text).toContain('Inscriptions: Signed lower right');
  });
});
