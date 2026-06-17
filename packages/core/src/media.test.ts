import { describe, it, expect } from 'vitest';
import {
  extFromContentType, kindForExt, displayName, fmtFromUrl, extFor, safeName,
} from './media';

// Media-kind helpers ported from harpe tests/test_extract.py.
describe('extFromContentType', () => {
  it('maps known types, ignores params, returns null for unknown', () => {
    expect(extFromContentType('video/mp4')).toBe('.mp4');
    expect(extFromContentType('image/jpeg; charset=binary')).toBe('.jpg');
    expect(extFromContentType('audio/mpeg')).toBe('.mp3');
    expect(extFromContentType('application/octet-stream')).toBeNull();
    expect(extFromContentType(null)).toBeNull();
  });
});

describe('kindForExt', () => {
  it('classifies video / audio / image (default)', () => {
    expect(kindForExt('.mp4')).toBe('video');
    expect(kindForExt('.MP3')).toBe('audio');
    expect(kindForExt('.png')).toBe('image');
    expect(kindForExt('')).toBe('image');
  });
});

describe('displayName', () => {
  it('adds a .jpg when there is no media extension', () => {
    expect(displayName('https://x/foo').endsWith('.jpg')).toBe(true);
    expect(displayName('https://x/bar.png')).toBe('bar.png');
  });
  it('keeps a video extension (no <name>.mp4.jpg regression)', () => {
    expect(displayName('https://video.twimg.com/amplify_video/123/vid/avc1/1080x1080/r2mYBJRfVf53plLi.mp4?tag=21'))
      .toBe('r2mYBJRfVf53plLi.mp4');
  });
});

// Format helpers (already shared; kept here as the canonical home).
describe('format helpers', () => {
  it('fmtFromUrl + extFor', () => {
    expect(fmtFromUrl('https://x/a.PNG')).toBe('png');
    expect(fmtFromUrl('https://x/a.jpg?q=1')).toBe('jpeg');
    expect(extFor('jpeg')).toBe('jpg');
  });
  it('safeName strips illegal chars and caps length', () => {
    expect(safeName('Title', 'Artist', 'png')).toBe('Artist - Title.png');
    expect(safeName('a/b:c', '', 'jpg')).toBe('abc.jpg');
  });
});
