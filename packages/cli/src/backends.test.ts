import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { videoArgs, audioArgs, dezoomifyArgs, slugFromUrl } from './backends';
import { ytdlpExtraArgs } from './config';

// Ported from harpe tests/test_backends.py.
const ENV_KEYS = ['HARPE_COOKIES_FROM_BROWSER', 'HARPE_IMPERSONATE'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('ytdlpExtraArgs', () => {
  it('always includes resilience flags', () => {
    const a = ytdlpExtraArgs();
    expect(a).toContain('--retries');
    expect(a).toContain('--fragment-retries');
    expect(a).toContain('--concurrent-fragments');
  });

  it('no cookies/impersonate by default', () => {
    const a = ytdlpExtraArgs();
    expect(a).not.toContain('--cookies-from-browser');
    expect(a).not.toContain('--impersonate');
  });

  it('cookies + impersonate are opt-in via env', () => {
    process.env.HARPE_COOKIES_FROM_BROWSER = 'firefox';
    process.env.HARPE_IMPERSONATE = 'chrome';
    const a = ytdlpExtraArgs();
    expect(a[a.indexOf('--cookies-from-browser') + 1]).toBe('firefox');
    expect(a[a.indexOf('--impersonate') + 1]).toBe('chrome');
  });
});

describe('arg builders', () => {
  it('videoArgs carries the resilience flags + output template', () => {
    const a = videoArgs(['https://x/v'], '/V');
    expect(a).toContain('--retries');
    expect(a).toContain('--merge-output-format');
    expect(a.at(-1)).toBe('https://x/v');
    expect(a.join(' ')).toContain('/V/');
  });

  it('audioArgs extracts best audio', () => {
    const a = audioArgs(['https://x/a'], '/A');
    expect(a).toContain('-x');
    expect(a).toContain('--embed-thumbnail');
  });

  it('dezoomifyArgs: capped vs full resolution', () => {
    expect(dezoomifyArgs('s', 'o', 4096)).toEqual(['--max-width', '4096', '--max-height', '4096', 's', 'o']);
    expect(dezoomifyArgs('s', 'o', 0)).toEqual(['-l', 's', 'o']);
  });
});

describe('slugFromUrl', () => {
  it('Google Arts asset id', () => {
    expect(slugFromUrl('https://artsandculture.google.com/asset/the-feast-of-belshazzar/abc123'))
      .toBe('the-feast-of-belshazzar');
  });
  it('last path segment', () => {
    expect(slugFromUrl('https://example.org/art/the-deluge/')).toBe('the-deluge');
  });
});
