import { describe, it, expect, vi, afterEach } from 'vitest';
import { collect, wmOriginal, sizeHint, select, parseDimensions, displayName, probe, type Probed } from './extract';

// Ported from harpe tests/test_extract.py + test_select.py.
describe('wmOriginal', () => {
  it('maps a Wikimedia thumb to its original', () => {
    const thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/John_Martin_-_Macbeth.jpg/960px-John_Martin_-_Macbeth.jpg';
    const orig = 'https://upload.wikimedia.org/wikipedia/commons/c/ce/John_Martin_-_Macbeth.jpg';
    expect(wmOriginal(thumb)).toBe(orig);
  });
  it('passes a non-thumb URL through', () => {
    expect(wmOriginal('https://example.org/a/b/photo.jpg')).toBe('https://example.org/a/b/photo.jpg');
  });
});

describe('sizeHint', () => {
  it('reads width from query, /NNNpx- segment, or descriptor', () => {
    expect(sizeHint('https://x/i.jpg?w=2000')).toBe(2000);
    expect(sizeHint('https://x/640px-i.jpg')).toBe(640);
    expect(sizeHint('https://x/i.jpg', 1500)).toBe(1500);
  });
});

describe('collect', () => {
  it('dedupes Wikimedia variants to one original', () => {
    const html = `
      <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/A.jpg/330px-A.jpg"
           srcset="https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/A.jpg/660px-A.jpg 2x">`;
    expect(collect(html, 'https://en.wikipedia.org/')).toEqual([
      'https://upload.wikimedia.org/wikipedia/commons/c/ce/A.jpg',
    ]);
  });

  it('absolutizes relative URLs and skips data: URIs', () => {
    const html = '<img src="/img/a.png"><img src="data:image/png;base64,xxxx">';
    expect(collect(html, 'https://site.test/page')).toEqual(['https://site.test/img/a.png']);
  });

  it('picks the largest query-size variant of the same path', () => {
    const html = '<img src="https://cdn.test/p.jpg?w=400"><img src="https://cdn.test/p.jpg?w=1600">';
    expect(collect(html, 'https://cdn.test/')).toEqual(['https://cdn.test/p.jpg?w=1600']);
  });
});

describe('select', () => {
  const P = (url: string, verdict: Probed['verdict'], size?: [number, number]): Probed => ({ url, verdict, size });

  it('ranks by pixel area, drops non-images, keeps unknowns last', () => {
    const rows = select([
      P('big', 'ok', [4000, 3000]),
      P('small', 'ok', [200, 150]),
      P('html', 'drop'),
      P('mystery', 'image'),
    ], 100);
    expect(rows.map((r) => r.url)).toEqual(['big', 'small', 'mystery']);
    expect(rows[0].dim).toBe('4000x3000');
  });

  it('relaxes the floor rather than returning an empty list', () => {
    const rows = select([P('tiny', 'ok', [60, 60])], 100);
    expect(rows.map((r) => r.url)).toEqual(['tiny']); // would be dropped by minpx, but kept
  });
});

// ─── parseDimensions (hand-rolled header parser) ─────────────────────────────

describe('parseDimensions', () => {
  function bytes(...vals: number[]): Uint8Array {
    return new Uint8Array(vals);
  }

  it('parses a minimal PNG header', () => {
    // PNG signature (8) + chunk length (4) + IHDR (4) + width (4) + height (4)
    const png = bytes(
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
      0x00, 0x00, 0x00, 0x0d,                           // chunk length = 13
      0x49, 0x48, 0x44, 0x52,                           // IHDR
      0x00, 0x00, 0x03, 0xe8,                           // width = 1000
      0x00, 0x00, 0x02, 0x58,                           // height = 600
    );
    expect(parseDimensions(png)).toEqual([1000, 600]);
  });

  it('parses a GIF89a header', () => {
    // GIF89a + width LE + height LE
    const gif = bytes(
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      0x40, 0x01,                           // width = 320 (LE)
      0x58, 0x00,                           // height = 88 (LE)
    );
    expect(parseDimensions(gif)).toEqual([320, 88]);
  });

  it('parses a GIF87a header', () => {
    const gif = bytes(
      0x47, 0x49, 0x46, 0x38, 0x37, 0x61, // GIF87a
      0x80, 0x02,                           // width = 640 (LE)
      0xe0, 0x01,                           // height = 480 (LE)
    );
    expect(parseDimensions(gif)).toEqual([640, 480]);
  });

  it('parses a VP8 WebP header', () => {
    // RIFF header + WEBP + VP8 chunk + frame tag + width/height
    // Frame tag (3 bytes) + start code (3 bytes) = 6 bytes at offset 20
    // Width/height at offset 26-29 (14-bit LE masked with 0x3FFF)
    const webp = bytes(
      0x52, 0x49, 0x46, 0x46,                           // RIFF
      0x00, 0x00, 0x00, 0x00,                           // file size (ignored)
      0x57, 0x45, 0x42, 0x50,                           // WEBP
      0x56, 0x50, 0x38, 0x20,                           // VP8 (lossy)
      0x00, 0x00, 0x00, 0x00,                           // chunk size (ignored)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,               // frame tag + start code
      0x00, 0x05,                                       // width = 1280 >> lo=0x00, hi=0x05 → (0x0500 & 0x3fff) = 1280
      0x00, 0x02,                                       // height = 512
    );
    // Width: buf[26]=0x00, buf[27]=0x05 → 0x0500 & 0x3fff = 1280
    // Height: buf[28]=0x00, buf[29]=0x02 → 0x0200 & 0x3fff = 512
    const dims = parseDimensions(webp);
    expect(dims).not.toBeNull();
    expect(dims![0]).toBe(1280);
    expect(dims![1]).toBe(512);
  });

  it('parses a minimal JPEG SOF0 header', () => {
    // SOI + APP0 marker + SOF0 marker with dimensions
    const jpeg = bytes(
      0xff, 0xd8,             // SOI
      0xff, 0xe0,             // APP0 marker
      0x00, 0x10,             // segment length = 16 (includes itself)
      // 14 bytes of JFIF data (we skip them)
      0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0,             // SOF0 marker
      0x00, 0x11,             // SOF0 segment length (17 bytes)
      0x08,                   // precision
      0x04, 0x00,             // height = 1024
      0x05, 0x00,             // width = 1280
    );
    const dims = parseDimensions(jpeg);
    expect(dims).not.toBeNull();
    expect(dims![1]).toBe(1024);
    expect(dims![0]).toBe(1280);
  });

  it('returns null for empty/unrecognised bytes', () => {
    expect(parseDimensions(new Uint8Array([0, 0, 0, 0]))).toBeNull();
    expect(parseDimensions(new Uint8Array([]))).toBeNull();
  });
});

// ─── displayName ─────────────────────────────────────────────────────────────

describe('displayName', () => {
  it('returns basename with extension', () => {
    expect(displayName('https://cdn.test/photos/sunset.jpg?w=800')).toBe('sunset.jpg');
  });

  it('appends .jpg if no media extension', () => {
    expect(displayName('https://cdn.test/photos/abc123')).toBe('abc123.jpg');
  });

  it('decodes percent-encoded characters (space stays as space, [\w.\- ] allowed)', () => {
    // %20 = space; displayName allows [\w.\- ] so space is kept, not replaced
    expect(displayName('https://cdn.test/fotos/mi%20foto.jpg')).toBe('mi foto.jpg');
  });

  it('caps base name at 80 chars before appending .jpg', () => {
    // base name is 100 'a's; slice(0,80) gives 80 'a's; no media ext → +.jpg = 84 total
    const long = 'a'.repeat(100);
    const result = displayName(`https://cdn.test/${long}`);
    // The slice(0,80) applies to the name before appending .jpg, so total may exceed 80
    expect(result).toBe('a'.repeat(80) + '.jpg');
  });

  it('does not append .jpg when URL already has a media ext', () => {
    expect(displayName('https://cdn.test/photo.webp')).toBe('photo.webp');
  });
});

// ─── probe (network, mocked) ──────────────────────────────────────────────────

describe('probe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makePNG(w: number, h: number): Uint8Array {
    const buf = new Uint8Array(24);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
    buf[8] = 0; buf[9] = 0; buf[10] = 0; buf[11] = 13;
    buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52;
    buf[16] = (w >> 24) & 0xff; buf[17] = (w >> 16) & 0xff; buf[18] = (w >> 8) & 0xff; buf[19] = w & 0xff;
    buf[20] = (h >> 24) & 0xff; buf[21] = (h >> 16) & 0xff; buf[22] = (h >> 8) & 0xff; buf[23] = h & 0xff;
    return buf;
  }

  it('returns ok + dimensions for a recognisable image header', async () => {
    const pngBytes = makePNG(800, 600);
    const mockBody = new ReadableStream({
      start(ctrl) { ctrl.enqueue(pngBytes); ctrl.close(); },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'image/png' },
      body: mockBody,
    }));
    const result = await probe('https://cdn.test/photo.png');
    expect(result.verdict).toBe('ok');
    expect(result.size).toEqual([800, 600]);
  });

  it('returns drop for SVG content-type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'image/svg+xml' },
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    }));
    const result = await probe('https://cdn.test/icon.svg');
    expect(result.verdict).toBe('drop');
  });

  it('returns drop for non-image content-type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'text/html' },
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    }));
    const result = await probe('https://cdn.test/page.html');
    expect(result.verdict).toBe('drop');
  });

  it('returns retry on HTTP 4xx/5xx errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
      headers: { get: () => null },
      body: null,
    }));
    const result = await probe('https://cdn.test/missing.jpg');
    expect(result.verdict).toBe('retry');
  });

  it('returns retry on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await probe('https://cdn.test/photo.jpg');
    expect(result.verdict).toBe('retry');
  });

  it('retries once on HTTP 429', async () => {
    const pngBytes = makePNG(100, 100);
    const mockBody = new ReadableStream({
      start(ctrl) { ctrl.enqueue(pngBytes); ctrl.close(); },
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        status: 429, ok: false,
        headers: { get: () => null }, body: null,
      })
      .mockResolvedValueOnce({
        status: 200, ok: true,
        headers: { get: () => 'image/png' },
        body: mockBody,
      }),
    );
    const result = await probe('https://cdn.test/photo.png');
    expect(result.verdict).toBe('ok');
    expect(result.size).toEqual([100, 100]);
  });
});
