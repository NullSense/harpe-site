import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./art.js', () => ({ gatherSources: vi.fn() }));

import preview from './preview.js';
import { gatherSources } from './art.js';

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

beforeEach(() => vi.mocked(gatherSources).mockReset());

describe('preview resolver', () => {
  it('resolves the exact item by v and returns title/img/desc', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([item({ id: 'aic-1' }), item({ id: 'aic-2', title: 'Other' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'monet', v: 'aic-2' } } as never, r as never);
    expect(r.body).toMatchObject({ title: 'Other', img: 'p.jpg', desc: 'Claude Monet · 1906 · Oil on canvas' });
  });

  it('falls back to the first item when v is absent', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([item({ title: 'First' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'monet' } } as never, r as never);
    expect(r.body.title).toBe('First');
  });

  it('returns {} for an empty query (no work done)', async () => {
    const r = res();
    await preview({ query: {} } as never, r as never);
    expect(r.body).toEqual({});
    expect(gatherSources).not.toHaveBeenCalled();
  });

  it('survives a source that rejects (partial results)', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.reject(new Error('500'))],
      ['Met', Promise.resolve([item({ id: 'met-9', title: 'Met work' })])],
    ] as never);
    const r = res();
    await preview({ query: { q: 'x', v: 'met-9' } } as never, r as never);
    expect(r.body.title).toBe('Met work');
  });
});
