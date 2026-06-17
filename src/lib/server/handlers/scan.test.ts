import { describe, it, expect } from 'vitest';
import { wmOriginal, sizeHint, resolveUrl } from './scan.js';

// ─── wmOriginal ───────────────────────────────────────────────────────────────

describe('wmOriginal', () => {
  it('strips Wikimedia thumb path, returning original URL', () => {
    const thumb =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo.jpg/320px-Foo.jpg';
    const expected = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.jpg';
    expect(wmOriginal(thumb)).toBe(expected);
  });

  it('handles a thumb URL with a deeper path', () => {
    const thumb =
      'https://upload.wikimedia.org/wikipedia/en/thumb/x/y/z/Bar.png/120px-Bar.png';
    const expected = 'https://upload.wikimedia.org/wikipedia/en/x/y/z/Bar.png';
    expect(wmOriginal(thumb)).toBe(expected);
  });

  it('passes through non-Wikimedia URLs unchanged', () => {
    const url = 'https://example.com/images/photo.jpg';
    expect(wmOriginal(url)).toBe(url);
  });

  it('passes through a plain Wikimedia URL with no /thumb/ segment', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.jpg';
    expect(wmOriginal(url)).toBe(url);
  });
});

// ─── sizeHint ─────────────────────────────────────────────────────────────────

describe('sizeHint', () => {
  it('returns the descriptor value when supplied', () => {
    expect(sizeHint('https://example.com/img.jpg', 1920)).toBe(1920);
  });

  it('reads ?w= query param', () => {
    expect(sizeHint('https://example.com/img.jpg?w=800')).toBe(800);
  });

  it('reads ?width= query param', () => {
    expect(sizeHint('https://example.com/img.jpg?width=1200')).toBe(1200);
  });

  it('reads ?sz= query param', () => {
    expect(sizeHint('https://example.com/img.jpg?sz=640')).toBe(640);
  });

  it('reads ?size= query param', () => {
    expect(sizeHint('https://example.com/img.jpg?size=2048')).toBe(2048);
  });

  it('reads ?mw= query param', () => {
    expect(sizeHint('https://example.com/img.jpg?mw=480')).toBe(480);
  });

  it('extracts px width from path like /320px-Foo.jpg', () => {
    expect(sizeHint('https://upload.wikimedia.org/thumb/a/ab/Foo.jpg/320px-Foo.jpg')).toBe(320);
  });

  it('returns 0 for a URL with no size hints', () => {
    expect(sizeHint('https://example.com/photo.jpg')).toBe(0);
  });

  it('ignores non-numeric query values', () => {
    expect(sizeHint('https://example.com/img.jpg?w=abc')).toBe(0);
  });

  it('prioritises descriptor over query param when both present', () => {
    expect(sizeHint('https://example.com/img.jpg?w=800', 1600)).toBe(1600);
  });
});

// ─── resolveUrl ───────────────────────────────────────────────────────────────

describe('resolveUrl', () => {
  const BASE = 'https://example.com/gallery/';

  it('resolves a relative URL against the base', () => {
    expect(resolveUrl('images/photo.jpg', BASE)).toBe('https://example.com/gallery/images/photo.jpg');
  });

  it('returns an absolute http URL as-is (strips fragment)', () => {
    expect(resolveUrl('https://cdn.example.com/img.jpg#foo', BASE)).toBe('https://cdn.example.com/img.jpg');
  });

  it('returns an absolute https URL unchanged', () => {
    expect(resolveUrl('https://cdn.example.com/img.png', BASE)).toBe('https://cdn.example.com/img.png');
  });

  it('returns null for data: URIs', () => {
    expect(resolveUrl('data:image/png;base64,abc', BASE)).toBeNull();
  });

  it('returns null for javascript: URIs', () => {
    expect(resolveUrl('javascript:void(0)', BASE)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveUrl('', BASE)).toBeNull();
  });

  it('returns null for ftp: URLs (non-http/https)', () => {
    expect(resolveUrl('ftp://files.example.com/img.jpg', BASE)).toBeNull();
  });

  it('trims leading/trailing whitespace on href', () => {
    expect(resolveUrl('  https://example.com/img.jpg  ', BASE)).toBe('https://example.com/img.jpg');
  });

  it('returns null for unparseable href', () => {
    // A bare malformed string that URL() cannot resolve (no protocol, not relative)
    expect(resolveUrl(':::bad', 'not-a-base')).toBeNull();
  });

  it('strips the fragment from resolved URLs', () => {
    expect(resolveUrl('photo.jpg#anchor', BASE)).toBe('https://example.com/gallery/photo.jpg');
  });
});
