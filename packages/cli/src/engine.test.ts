import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { join } from 'node:path';
import { decideFile, sanitizeStem, groupSubpath, origin, scanPage, enumerateImages } from './engine';
import type { MediaKind } from '@harpe/core';

// Mock node:child_process at the module level (required for ESM spying).
// Individual tests replace spawn via mockSpawnImpl.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((..._args: unknown[]) => {
      // Default: pretend gallery-dl is not installed
      throw new Error('ENOENT');
    }),
  };
});

// Mock extract.pageImages so scanPage/enumerateImages fallback is testable.
vi.mock('./extract.js', async () => {
  const actual = await vi.importActual<typeof import('./extract.js')>('./extract.js');
  return {
    ...actual,
    pageImages: vi.fn().mockResolvedValue([]),
  };
});

const ROOTS: Record<MediaKind, string> = { image: '/Pictures/harpe', video: '/Videos/harpe', audio: '/Music/harpe' };

// ─── Existing pure-function tests ────────────────────────────────────────────

describe('decideFile', () => {
  it('video → video root, keeps .mp4 (no .mp4.jpg), nests by site', () => {
    const d = decideFile({
      url: 'https://video.twimg.com/amplify_video/1/vid/avc1/1080x1080/r2mYBJRfVf53plLi.mp4?tag=21',
      host: 'x.com', contentType: 'video/mp4', roots: ROOTS,
    });
    expect(d).toEqual({ dir: join('/Videos/harpe', 'x.com'), name: 'r2mYBJRfVf53plLi.mp4', kind: 'video' });
  });

  it('extensionless URL gets its extension from the Content-Type', () => {
    const d = decideFile({ url: 'https://cdn.example.com/media/abc123', host: 'cdn.example.com', contentType: 'image/jpeg', roots: ROOTS });
    expect(d.name).toBe('abc123.jpg');
    expect(d.kind).toBe('image');
    expect(d.dir).toBe(join('/Pictures/harpe', 'cdn.example.com'));
  });

  it('explicit dest overrides the typed/grouped dir', () => {
    const d = decideFile({ url: 'https://h/clip.mp4', host: 'h', contentType: 'video/mp4', roots: ROOTS, dest: '/chosen' });
    expect(d.dir).toBe('/chosen');
  });

  it('a descriptive suggested name becomes the stem (+ correct ext)', () => {
    const d = decideFile({ url: 'https://h/abc.mp4', host: 'h', contentType: 'video/mp4', suggested: 'a nice tweet', roots: ROOTS });
    expect(d.name).toBe('a nice tweet.mp4');
  });

  it('group=author nests by author, falling back to host', () => {
    expect(decideFile({ url: 'https://h/x.jpg', host: 'h', contentType: 'image/jpeg', author: 'bob', group: 'author', roots: ROOTS }).dir)
      .toBe(join('/Pictures/harpe', 'bob'));
    expect(decideFile({ url: 'https://h/x.jpg', host: 'h', contentType: 'image/jpeg', group: 'author', roots: ROOTS }).dir)
      .toBe(join('/Pictures/harpe', 'h'));
  });
});

describe('engine pure helpers', () => {
  it('sanitizeStem strips path-hostile chars + trims', () => {
    expect(sanitizeStem('  a/b:c*d  ')).toBe('abcd');
    expect(sanitizeStem('x'.repeat(200)).length).toBe(80);
  });
  it('groupSubpath modes', () => {
    expect(groupSubpath('site', 'h', 'bob')).toBe('h');
    expect(groupSubpath('none', 'h', 'bob')).toBe('');
    expect(groupSubpath('both', 'h', 'bob')).toBe('bob/h');
    expect(groupSubpath('author', 'h')).toBe('h');
  });
  it('origin returns scheme://host/', () => {
    expect(origin('https://x.com/a/b?c=1')).toBe('https://x.com/');
  });
});

// ─── enumerateImages + scanPage (ported from test_enumerate_images.py) ────────
//
// We mock node:child_process.spawn (for gallery-dl) at the module level above,
// and also mock extract.pageImages. Individual tests configure the mock spawn
// via makeSpawnMock() which returns an EventEmitter-shaped object.

type SpawnMock = {
  stdout: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
};

function makeSpawnMock(exitCode: number, stdout: string): SpawnMock {
  const stdoutListeners: Record<string, (data: Buffer) => void> = {};
  const processListeners: Record<string, (code?: number | null) => void> = {};
  const mock: SpawnMock = {
    stdout: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        stdoutListeners[event] = cb;
      }),
    },
    on: vi.fn((event: string, cb: (code?: number | null) => void) => {
      processListeners[event] = cb;
    }),
  };
  Promise.resolve().then(() => {
    if (stdoutListeners['data'] && stdout) stdoutListeners['data'](Buffer.from(stdout));
    if (processListeners['close']) processListeners['close'](exitCode);
  });
  return mock;
}

const MEDIA_URLS = [
  'https://example.com/images/photo1.jpg',
  'https://example.com/images/photo2.png',
  'https://cdn.example.com/gallery/img.webp',
];

const NON_MEDIA_LINES = [
  'https://example.com/',
  'not-a-url',
  '',
  '# gallery-dl output header',
];

describe('enumerateImages', () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let pageImagesMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const childProcess = await import('node:child_process');
    const extractModule = await import('./extract.js');
    spawnMock = childProcess.spawn as unknown as ReturnType<typeof vi.fn>;
    pageImagesMock = extractModule.pageImages as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockReset();
    pageImagesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses gallery-dl media URLs and returns them with dim="?"', async () => {
    const stdout = [...NON_MEDIA_LINES, ...MEDIA_URLS].join('\n');
    spawnMock.mockReturnValue(makeSpawnMock(0, stdout));

    const result = await enumerateImages('https://example.com/gallery');

    expect(result).toHaveLength(3);
    expect(result[0].url).toBe(MEDIA_URLS[0]);
    expect(result[1].url).toBe(MEDIA_URLS[1]);
    expect(result[2].url).toBe(MEDIA_URLS[2]);
    for (const r of result) {
      expect(r.dim).toBe('?');
      expect(r.width).toBeUndefined();
      expect(r.height).toBeUndefined();
    }
  });

  it('uses the URL basename as the name', async () => {
    spawnMock.mockReturnValue(makeSpawnMock(0, 'https://cdn.example.com/images/sunset.jpg\n'));
    const result = await enumerateImages('https://example.com/page');
    expect(result[0].name).toBe('sunset.jpg');
  });

  it('matches extensions case-insensitively', async () => {
    spawnMock.mockReturnValue(makeSpawnMock(0, 'https://x.com/photo.JPEG\nhttps://x.com/pic.PNG\n'));
    const result = await enumerateImages('https://x.com/g');
    expect(result).toHaveLength(2);
  });

  it('falls back to scanPage when gallery-dl exits 64', async () => {
    spawnMock.mockReturnValue(makeSpawnMock(64, ''));
    pageImagesMock.mockResolvedValue([
      { url: 'https://x.com/a.jpg', name: 'a.jpg', dim: '800x600' },
    ]);
    const result = await enumerateImages('https://x.com/page');
    expect(result[0].url).toBe('https://x.com/a.jpg');
    expect(result[0].dim).toBe('800x600');
    expect(result[0].width).toBe(800);
    expect(result[0].height).toBe(600);
  });

  it('falls back to scanPage when gallery-dl returns no media URLs (exit 0)', async () => {
    spawnMock.mockReturnValue(makeSpawnMock(0, '# some non-url output\nhttps://x.com/\n'));
    pageImagesMock.mockResolvedValue([
      { url: 'https://x.com/img.gif', name: 'img.gif', dim: '?' },
    ]);
    const result = await enumerateImages('https://x.com/page');
    expect(result[0].url).toBe('https://x.com/img.gif');
    expect(result[0].dim).toBe('?');
    expect(result[0].width).toBeUndefined();
  });

  it('falls back to scanPage when gallery-dl is not installed (spawn throws)', async () => {
    spawnMock.mockImplementation(() => { throw new Error('ENOENT'); });
    pageImagesMock.mockResolvedValue([
      { url: 'https://x.com/img.jpg', name: 'img.jpg', dim: '1200x900' },
    ]);
    const result = await enumerateImages('https://x.com/page');
    expect(result[0].url).toBe('https://x.com/img.jpg');
    expect(result[0].width).toBe(1200);
    expect(result[0].height).toBe(900);
  });

  it('uses media URLs even when gallery-dl exits non-zero (not 64)', async () => {
    spawnMock.mockReturnValue(makeSpawnMock(1, 'https://example.com/photo.avif\nhttps://example.com/photo2.tiff\n'));
    const result = await enumerateImages('https://example.com/g');
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://example.com/photo.avif');
  });

  it('falls back to scanPage when non-64 exit + no media URLs', async () => {
    spawnMock.mockReturnValue(makeSpawnMock(1, 'error: something failed\n'));
    pageImagesMock.mockResolvedValue([]);
    const result = await enumerateImages('https://x.com/page');
    expect(result).toEqual([]);
  });
});

describe('scanPage', () => {
  let pageImagesMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const extractModule = await import('./extract.js');
    pageImagesMock = extractModule.pageImages as unknown as ReturnType<typeof vi.fn>;
    pageImagesMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('converts pageImages rows to ImageRow with parsed dimensions', async () => {
    pageImagesMock.mockResolvedValue([
      { url: 'https://cdn.test/a.jpg', name: 'a.jpg', dim: '1920x1080' },
      { url: 'https://cdn.test/b.png', name: 'b.png', dim: '?' },
    ]);
    const result = await scanPage('https://example.com/page');
    expect(result[0]).toMatchObject({ url: 'https://cdn.test/a.jpg', dim: '1920x1080', width: 1920, height: 1080 });
    expect(result[1]).toMatchObject({ url: 'https://cdn.test/b.png', dim: '?', width: undefined, height: undefined });
  });
});
