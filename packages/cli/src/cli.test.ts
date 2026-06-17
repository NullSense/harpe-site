import { describe, it, expect } from 'vitest';
import { parseArgs, isUrl, readUrls } from './cli.js';

describe('parseArgs', () => {
  it('defaults to auto mode with no flags', () => {
    expect(parseArgs(['https://example.com'])).toMatchObject({ mode: 'auto', json: false, urls: ['https://example.com'] });
  });

  it('maps each mode flag (short + long)', () => {
    expect(parseArgs(['-v']).mode).toBe('video');
    expect(parseArgs(['--audio']).mode).toBe('audio');
    expect(parseArgs(['-i']).mode).toBe('image');
    expect(parseArgs(['-p']).mode).toBe('page');
    expect(parseArgs(['--art']).mode).toBe('art');
    expect(parseArgs(['-r']).mode).toBe('reverse');
    expect(parseArgs(['-s']).mode).toBe('search');
    expect(parseArgs(['-F']).mode).toBe('fetch');
  });

  it('last mode flag wins (mutually exclusive)', () => {
    expect(parseArgs(['-v', '-s']).mode).toBe('search');
  });

  it('parses --json, --referer and --dest with their values', () => {
    const a = parseArgs(['-F', '--json', '--referer', 'https://ref', '--dest', '/tmp/out', 'https://img']);
    expect(a).toMatchObject({ mode: 'fetch', json: true, referer: 'https://ref', dest: '/tmp/out' });
    expect(a.urls).toEqual(['https://img']);
  });

  it('keeps only non-flag positionals as urls', () => {
    expect(parseArgs(['-s', 'claude', 'monet']).urls).toEqual(['claude', 'monet']);
  });
});

describe('isUrl', () => {
  it('accepts http(s) URLs only', () => {
    expect(isUrl('https://x.com')).toBe(true);
    expect(isUrl('http://x.com')).toBe(true);
    expect(isUrl('ftp://x.com')).toBe(false);
    expect(isUrl('monet water lilies')).toBe(false);
  });
});

describe('readUrls', () => {
  it('drops flag-shaped args', () => {
    expect(readUrls(['https://a', '--json', 'https://b'])).toEqual(['https://a', 'https://b']);
  });
});
