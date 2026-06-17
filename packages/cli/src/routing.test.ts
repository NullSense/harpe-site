import { describe, it, expect } from 'vitest';
import { cleanTitle, isReferencePage, isArtUrl } from './routing';

// Ported from harpe tests/test_routing.py.
describe('cleanTitle', () => {
  it('strips a trailing " | Site"', () => {
    expect(cleanTitle('‘Moses Breaketh the Tables’, John Martin, published 1833 | Tate'))
      .toBe('‘Moses Breaketh the Tables’, John Martin, published 1833');
  });

  it('strips a trailing " - Museum"', () => {
    expect(cleanTitle('The Night Watch - Rijksmuseum')).toBe('The Night Watch');
  });

  it('keeps "Title - Artist" (artist is not a museum keyword, no pipe)', () => {
    expect(cleanTitle('The Bedroom - Vincent van Gogh')).toBe('The Bedroom - Vincent van Gogh');
  });

  it('rejects bot-wall titles', () => {
    expect(cleanTitle('Just a moment...')).toBe('');
    expect(cleanTitle('Vercel Security Checkpoint')).toBe('');
  });

  it('decodes HTML entities', () => {
    expect(cleanTitle('Mother &amp; Child')).toBe('Mother & Child');
  });
});

describe('URL classification', () => {
  it('isReferencePage', () => {
    expect(isReferencePage('https://www.tate.org.uk/art/artworks/martin-x-t04895')).toBe(true);
    expect(isReferencePage('https://en.wikipedia.org/wiki/The_Deluge')).toBe(true);
    expect(isReferencePage('https://x.com/user/status/123')).toBe(false);
  });

  it('isArtUrl', () => {
    expect(isArtUrl('https://artsandculture.google.com/asset/x/y')).toBe(true);
    expect(isArtUrl('https://example.org/iiif/2/abc/manifest.json')).toBe(true);
    expect(isArtUrl('https://example.org/gallery')).toBe(false);
  });
});
