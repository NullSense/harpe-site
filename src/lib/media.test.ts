import { describe, it, expect } from 'vitest';
import { fmtFromUrl, safeName, displaySrc, isURL, extFor, LOSSLESS_FORMATS } from './media';

describe('fmtFromUrl', () => {
  it('maps extensions to formats', () => {
    expect(fmtFromUrl('a/b.jpg')).toBe('jpeg');
    expect(fmtFromUrl('a/b.JPEG')).toBe('jpeg');
    expect(fmtFromUrl('a/b.png')).toBe('png');
    expect(fmtFromUrl('a/b.tif')).toBe('tiff');
    expect(fmtFromUrl('a/b.webp')).toBe('webp');
  });
  it('handles query strings and unknowns', () => {
    expect(fmtFromUrl('a/b.png?x=1')).toBe('png');
    expect(fmtFromUrl('https://x/index.php?id=5&t=w')).toBe('jpeg');
  });
});

describe('safeName', () => {
  it('builds artist - title.ext and strips bad chars', () => {
    expect(safeName('Title', 'Artist', 'jpg')).toBe('Artist - Title.jpg');
    expect(safeName('a/b:c*?', '', 'png')).toBe('abc.png');
  });
});

describe('displaySrc', () => {
  it('proxies insecure http URLs', () => {
    expect(displaySrc('http://x.com/a.jpg')).toContain('/api/fetch?url=');
  });
  it('passes through https untouched', () => {
    expect(displaySrc('https://x.com/a.jpg')).toBe('https://x.com/a.jpg');
  });
});

describe('isURL / extFor / lossless', () => {
  it('detects urls', () => {
    expect(isURL('https://x.com')).toBe(true);
    expect(isURL('starry night')).toBe(false);
  });
  it('extFor', () => {
    expect(extFor('jpeg')).toBe('jpg');
    expect(extFor('png')).toBe('png');
  });
  it('lossless set', () => {
    expect(LOSSLESS_FORMATS.has('png')).toBe(true);
    expect(LOSSLESS_FORMATS.has('jpeg')).toBe(false);
  });
});
