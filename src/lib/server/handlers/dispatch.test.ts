import { describe, it, expect, vi } from 'vitest';
import { handlers } from './index.js';
import dispatch, { opFromRequest } from '../../../../api/[...path].js';

// The catch-all api/[...path].ts is the entire API surface now (Hobby 12-fn
// limit). These lock the routing contract so a missing/renamed handler or a
// broken dispatch is caught before it 404s a whole endpoint in prod.

const EXPECTED = [
  'analyze', 'art', 'art-stream', 'artist', 'depicts', 'deepzoom', 'fetch',
  'grab', 'iiif', 'preview', 'sauce', 'scan', 'stats', 'tile', 'x',
];

function res() {
  const r: any = { statusCode: 0, body: undefined };
  r.status = vi.fn((c: number) => { r.statusCode = c; return r; });
  r.json = vi.fn((b: unknown) => { r.body = b; return r; });
  return r;
}

describe('api dispatch', () => {
  it('registers every client-used endpoint', () => {
    for (const name of EXPECTED) expect(handlers[name], name).toBeTypeOf('function');
    expect(Object.keys(handlers).sort()).toEqual([...EXPECTED].sort());
  });

  it('derives the op from req.url (real Vercel: query.path is empty)', () => {
    // This is the prod shape that earlier 404'd everything → infinite spinners.
    expect(opFromRequest({ query: {}, url: '/api/art?q=monet' })).toBe('art');
    expect(opFromRequest({ query: {}, url: '/api/art-stream?q=monet' })).toBe('art-stream');
    expect(opFromRequest({ query: {}, url: '/api/x?id=1' })).toBe('x');
    // honour query.path when a runtime does populate it
    expect(opFromRequest({ query: { path: ['tile'] }, url: '/api/tile' })).toBe('tile');
    // no endpoint
    expect(opFromRequest({ query: {}, url: '/api/' })).toBe('');
  });

  it('404s an unknown op without invoking a handler', async () => {
    const r = res();
    await dispatch({ query: {}, url: '/api/totally-unknown' } as any, r as any);
    expect(r.statusCode).toBe(404);
    expect(r.body).toMatchObject({ error: expect.stringContaining('totally-unknown') });
  });

  it('404s when no op segment is present', async () => {
    const r = res();
    await dispatch({ query: {}, url: '/api/' } as any, r as any);
    expect(r.statusCode).toBe(404);
  });

  it('routes a known op (parsed from req.url) to its handler', async () => {
    const r = res();
    const spy = vi.spyOn(handlers, 'x').mockResolvedValue(undefined as never);
    await dispatch({ query: {}, url: '/api/x?id=1' } as any, r as any);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
