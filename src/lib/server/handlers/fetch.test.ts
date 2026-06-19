import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the network + SSRF guard so the redirect-following loop is deterministic.
// GuardError stays the real class (instanceof checks in the loop) via importActual.
vi.mock('undici', () => ({ fetch: vi.fn() }));
vi.mock('../guard.js', async (orig) => {
  const actual = await orig<typeof import('../guard.js')>();
  return {
    ...actual,
    guardUrl: vi.fn(async (u: string) => ({ url: u, ip: '203.0.113.7', family: 4 as const })),
    pinnedAgent: vi.fn(() => undefined),
  };
});

import { fetch } from 'undici';
import { deriveFilename, parseConvertParams, needsConversion, safeFetchImage, MAX_REDIRECTS } from './fetch.js';

const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => mockFetch.mockReset());

// Minimal undici-Response stand-ins for the redirect loop.
const redirectTo = (location: string) => ({
  status: 301,
  ok: false,
  headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
  body: { cancel: async () => {} },
});
const imageOk = () => ({
  status: 200,
  ok: true,
  headers: {
    get: (k: string) =>
      k.toLowerCase() === 'content-type' ? 'image/jpeg' : k.toLowerCase() === 'content-length' ? '1024' : null,
  },
  body: {},
});

// ─── safeFetchImage redirect handling (regression: Commons FilePath 502) ───────

describe('safeFetchImage redirect following', () => {
  // The exact chain a `http://commons.wikimedia.org/.../Special:FilePath/...`
  // URL produces: http→https, then FilePath→thumb→upload = 4 redirects. The old
  // MAX_REDIRECTS=3 threw "Too many redirects" → 502. This must now resolve.
  it('follows the 4-hop Wikimedia Commons FilePath chain to the image', async () => {
    mockFetch
      .mockResolvedValueOnce(redirectTo('https://commons.wikimedia.org/wiki/Special:FilePath/x.jpg'))
      .mockResolvedValueOnce(redirectTo('https://commons.wikimedia.org/redir/2'))
      .mockResolvedValueOnce(redirectTo('https://commons.wikimedia.org/redir/3'))
      .mockResolvedValueOnce(redirectTo('https://upload.wikimedia.org/wikipedia/commons/5/5b/x.jpg'))
      .mockResolvedValueOnce(imageOk());
    const r = await safeFetchImage(
      'http://commons.wikimedia.org/wiki/Special:FilePath/x.jpg',
      new AbortController(),
    );
    expect(r.contentType).toBe('image/jpeg');
    expect(mockFetch).toHaveBeenCalledTimes(5); // 4 redirects + final 200
  });

  it('still rejects an over-long redirect chain (SSRF redirect-loop guard intact)', async () => {
    for (let i = 0; i <= MAX_REDIRECTS + 1; i++) mockFetch.mockResolvedValueOnce(redirectTo(`https://x/${i}`));
    await expect(
      safeFetchImage('https://x/start', new AbortController()),
    ).rejects.toThrow(/Too many redirects/);
  });
});

// ─── deriveFilename ───────────────────────────────────────────────────────────

describe('deriveFilename', () => {
  it('uses the URL path basename when it has a known extension', () => {
    expect(deriveFilename('https://example.com/gallery/sunset.jpg', 'image/jpeg')).toBe('sunset.jpg');
  });

  it('appends a content-type extension when the path has no known ext', () => {
    expect(deriveFilename('https://example.com/api/download/42', 'image/png')).toBe('42.png');
  });

  it('appends .jpg as the fallback for unknown image content-types', () => {
    expect(deriveFilename('https://example.com/photo', 'image/x-unknown')).toBe('photo.jpg');
  });

  it('sanitises non-word characters in the basename', () => {
    const result = deriveFilename('https://example.com/image@2x!.png', 'image/png');
    expect(result).toMatch(/^image_2x_\.png$/);
  });

  it('uses "image" as stem fallback when path has no basename', () => {
    const result = deriveFilename('https://example.com/', 'image/jpeg');
    expect(result).toBe('image.jpg');
  });

  it('handles video content-type with .mp4 extension', () => {
    expect(deriveFilename('https://example.com/clip', 'video/mp4')).toBe('clip.mp4');
  });

  it('uses "video" stem for video URLs with no usable basename', () => {
    const result = deriveFilename('https://example.com/', 'video/mp4');
    expect(result).toBe('video.mp4');
  });

  it('uses "audio" stem for audio/mpeg URLs with no usable basename', () => {
    // audio/mpeg → CT_EXT → .mp3
    const result = deriveFilename('https://example.com/', 'audio/mpeg');
    expect(result).toBe('audio.mp3');
  });

  it('preserves existing .webp extension', () => {
    expect(deriveFilename('https://cdn.example.com/hero.webp', 'image/webp')).toBe('hero.webp');
  });

  it('respects the 80-char slice on long basenames', () => {
    const longName = 'a'.repeat(100) + '.jpg';
    const result = deriveFilename(`https://example.com/${longName}`, 'image/jpeg');
    // Sliced to 80 chars, which includes the extension
    expect(result.length).toBeLessThanOrEqual(84); // 80 stem + maybe ext
  });

  it('handles URL-encoded characters in path (space preserved, non-word chars replaced)', () => {
    // %20 decodes to a space; the sanitise regex [^\w.\- ]+ keeps spaces, so "my photo.jpg" is valid
    const result = deriveFilename('https://example.com/my%20photo.jpg', 'image/jpeg');
    expect(result).toBe('my photo.jpg');
  });
});

// ─── parseConvertParams ───────────────────────────────────────────────────────

describe('parseConvertParams', () => {
  it('returns empty object when no params present', () => {
    expect(parseConvertParams({})).toEqual({});
  });

  it('parses ?w=', () => {
    expect(parseConvertParams({ w: '800' })).toMatchObject({ w: 800 });
  });

  it('parses ?h=', () => {
    expect(parseConvertParams({ h: '600' })).toMatchObject({ h: 600 });
  });

  it('parses ?fmt=webp', () => {
    expect(parseConvertParams({ fmt: 'webp' })).toMatchObject({ fmt: 'webp' });
  });

  it('parses ?q=85', () => {
    expect(parseConvertParams({ q: '85' })).toMatchObject({ q: 85 });
  });

  it('rejects fmt not in allowlist', () => {
    const p = parseConvertParams({ fmt: 'bmp' });
    expect(p.fmt).toBeUndefined();
  });

  it('clamps quality below 1 to 1', () => {
    expect(parseConvertParams({ q: '0' })).toMatchObject({ q: 1 });
  });

  it('clamps quality above 100 to 100', () => {
    expect(parseConvertParams({ q: '200' })).toMatchObject({ q: 100 });
  });

  it('ignores w values outside 1–8000 range', () => {
    expect(parseConvertParams({ w: '0' }).w).toBeUndefined();
    expect(parseConvertParams({ w: '8001' }).w).toBeUndefined();
    expect(parseConvertParams({ w: '-5' }).w).toBeUndefined();
  });

  it('rounds non-integer numeric values', () => {
    expect(parseConvertParams({ w: '799.7' })).toMatchObject({ w: 800 });
  });

  it('ignores non-numeric strings', () => {
    expect(parseConvertParams({ w: 'abc' }).w).toBeUndefined();
    expect(parseConvertParams({ q: 'high' }).q).toBeUndefined();
  });

  it('accepts fmt case-insensitively', () => {
    expect(parseConvertParams({ fmt: 'JPEG' })).toMatchObject({ fmt: 'jpeg' });
  });

  it('handles array-valued query params (ignores them)', () => {
    // VercelRequest passes string[] for duplicate params
    expect(parseConvertParams({ w: ['800', '400'] }).w).toBeUndefined();
  });
});

// ─── needsConversion ─────────────────────────────────────────────────────────

describe('needsConversion', () => {
  it('returns false for an empty ConvertParams', () => {
    expect(needsConversion({})).toBe(false);
  });

  it('returns true when w is set', () => {
    expect(needsConversion({ w: 800 })).toBe(true);
  });

  it('returns true when h is set', () => {
    expect(needsConversion({ h: 600 })).toBe(true);
  });

  it('returns true when fmt is set', () => {
    expect(needsConversion({ fmt: 'webp' })).toBe(true);
  });

  it('returns true when q is set', () => {
    expect(needsConversion({ q: 85 })).toBe(true);
  });

  it('returns true when multiple params are set', () => {
    expect(needsConversion({ w: 800, fmt: 'avif', q: 75 })).toBe(true);
  });
});
