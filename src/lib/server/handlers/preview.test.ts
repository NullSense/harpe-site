import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./art.js', () => ({ gatherSources: vi.fn() }));
vi.mock('@harpe/sources', () => ({ loadArtistPage: vi.fn() }));
vi.mock('../guard.js', () => ({
  GuardError: class GuardError extends Error {
    constructor(public readonly status: number, message: string) { super(message); this.name = 'GuardError'; }
  },
  rateLimit: vi.fn(),
  clientIp: vi.fn(() => '1.2.3.4'),
}));

import preview from './preview.js';
import { gatherSources } from './art.js';
import { loadArtistPage } from '@harpe/sources';
import { rateLimit, GuardError } from '../guard.js';

function res() {
  const r: any = { code: 0, body: undefined, headers: {} };
  r.setHeader = (k: string, val: string) => { r.headers[k] = val; };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'aic-1', title: 'Water Lilies', artist: 'Claude Monet', date: '1906',
  medium: 'Oil on canvas', thumbUrl: 't.jpg', previewUrl: 'p.jpg', ...over,
});

beforeEach(() => {
  vi.mocked(gatherSources).mockReset();
  vi.mocked(loadArtistPage).mockReset();
  vi.mocked(rateLimit).mockResolvedValue(undefined);
});

describe('preview resolver', () => {
  it('previews an artist entity from ?artist=<QID> (title/img/desc from the KG node)', async () => {
    vi.mocked(loadArtistPage).mockResolvedValue({
      entity: { qid: 'Q189117', labelEn: 'Jan Matejko', description: 'Polish painter (1838–1893)', imageCommons: 'Matejko Self-portrait.jpg', workCount: 186 },
      works: [],
    } as never);
    const r = res();
    await preview({ query: { q: 'Jan Matejko', artist: 'Q189117' }, headers: {} } as never, r as never);
    expect(r.body.title).toBe('Jan Matejko');
    expect(r.body.desc).toContain('Polish painter');
    expect(r.body.img).toContain('Special:FilePath/Matejko');
    expect(r.body.img).toContain('width=');
    expect(gatherSources).not.toHaveBeenCalled(); // artist branch short-circuits the work search
  });

  it('falls back to the work search when ?artist= is not a QID', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([item({ title: 'A work' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'monet', artist: 'not-a-qid' }, headers: {} } as never, r as never);
    expect(r.body.title).toBe('A work');
    expect(loadArtistPage).not.toHaveBeenCalled();
  });

  it('resolves the exact item by v and returns title/img/desc', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([item({ id: 'aic-1' }), item({ id: 'aic-2', title: 'Other' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'monet', v: 'aic-2' }, headers: {} } as never, r as never);
    expect(r.body).toMatchObject({ title: 'Other', img: 'p.jpg', desc: 'Claude Monet · 1906 · Oil on canvas' });
  });

  it('falls back to the first item when v is absent', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([item({ title: 'First' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'monet' }, headers: {} } as never, r as never);
    expect(r.body.title).toBe('First');
  });

  it('returns {} for an empty query (no work done)', async () => {
    const r = res();
    await preview({ query: {}, headers: {} } as never, r as never);
    expect(r.body).toEqual({});
    expect(gatherSources).not.toHaveBeenCalled();
  });

  it('survives a source that rejects (partial results)', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.reject(new Error('500'))],
      ['Met', Promise.resolve([item({ id: 'met-9', title: 'Met work' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'x', v: 'met-9' }, headers: {} } as never, r as never);
    expect(r.body.title).toBe('Met work');
  });

  it('returns {} (200) when rate limit is exceeded — card degrades gracefully, never errors', async () => {
    vi.mocked(rateLimit).mockRejectedValue(new GuardError(429, 'Rate limit exceeded — try again in a minute'));
    const r = res();
    await preview({ query: { q: 'monet' }, headers: {} } as never, r as never);
    // Status 200 (not 429) — preview must never block the social card
    expect(r.code).toBe(200);
    expect(r.body).toEqual({});
    // gatherSources should not be called when throttled
    expect(gatherSources).not.toHaveBeenCalled();
  });

  it('rethrows non-GuardError exceptions from rateLimit', async () => {
    vi.mocked(rateLimit).mockRejectedValue(new Error('infra failure'));
    const r = res();
    await expect(
      preview({ query: { q: 'monet' }, headers: {} } as never, r as never),
    ).rejects.toThrow('infra failure');
  });

  it('assembles desc from artist, date, medium — omits blank fields', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([item({ artist: '', date: '1906', medium: '' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'monet' }, headers: {} } as never, r as never);
    expect(r.body.desc).toBe('1906');
  });

  it('uses previewUrl as img; falls back to thumbUrl when previewUrl is empty', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([item({ previewUrl: '', thumbUrl: 'thumb.jpg' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'x' }, headers: {} } as never, r as never);
    expect(r.body.img).toBe('thumb.jpg');
  });

  it('returns {} when all sources resolve with empty arrays', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([])],
      ['Met', Promise.resolve([])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'nothing' }, headers: {} } as never, r as never);
    expect(r.body).toEqual({});
  });

  it('sets the CDN cache header on every response', async () => {
    const r = res();
    await preview({ query: {}, headers: {} } as never, r as never);
    expect(r.headers['Cache-Control']).toContain('s-maxage=3600');
  });
});
