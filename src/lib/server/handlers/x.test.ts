import { describe, it, expect } from 'vitest';
import { tweetToken, variantLabel } from './x.js';

// ─── tweetToken ───────────────────────────────────────────────────────────────

describe('tweetToken', () => {
  it('is deterministic for the same id', () => {
    expect(tweetToken('1234567890')).toBe(tweetToken('1234567890'));
  });

  it('produces different tokens for different ids', () => {
    expect(tweetToken('111111111111111')).not.toBe(tweetToken('222222222222222'));
  });

  it('returns a non-empty string without dots or leading zeros', () => {
    const token = tweetToken('20');
    expect(token).toMatch(/^[^.0][^.]*$/);
  });

  it('matches the formula: (id/1e15 * pi).toString(36) stripped of 0s and dots', () => {
    const id = '1516134180078280708';
    // Recompute inline to pin the exact algorithm
    const expected = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    expect(tweetToken(id)).toBe(expected);
  });
});

// ─── variantLabel ─────────────────────────────────────────────────────────────

describe('variantLabel', () => {
  it('extracts height from a WxH path segment', () => {
    expect(variantLabel('https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/clip.mp4', 2176000)).toBe('720p');
  });

  it('uses height (second dimension) not width', () => {
    expect(variantLabel('https://video.twimg.com/ext_tw_video/123/pu/vid/1920x1080/clip.mp4', 4000000)).toBe('1080p');
  });

  it('falls back to kbps label when no WxH segment is present', () => {
    expect(variantLabel('https://video.twimg.com/tweet_video/abc.mp4', 832000)).toBe('832kbps');
  });

  it('falls back to "video" when no WxH and bitrate is zero', () => {
    expect(variantLabel('https://video.twimg.com/tweet_video/abc.mp4', 0)).toBe('video');
  });

  it('handles 4K resolution correctly', () => {
    expect(variantLabel('https://video.twimg.com/ext_tw_video/123/pu/vid/3840x2160/clip.mp4', 10000000)).toBe('2160p');
  });
});
