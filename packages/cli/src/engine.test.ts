import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decideFile, sanitizeStem, groupSubpath, origin } from './engine';
import type { MediaKind } from '@harpe/core';

const ROOTS: Record<MediaKind, string> = { image: '/Pictures/harpe', video: '/Videos/harpe', audio: '/Music/harpe' };

// Ported from harpe tests/test_engine.py (the filename/folder/kind decision —
// the part those integration tests actually assert on).
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
