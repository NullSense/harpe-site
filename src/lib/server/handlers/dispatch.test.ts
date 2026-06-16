import { describe, it, expect, vi } from 'vitest';
import { handlers } from './index.js';
import dispatch from '../../../../api/[...path].js';

// The catch-all api/[...path].ts is the entire API surface now (Hobby 12-fn
// limit). These lock the routing contract so a missing/renamed handler or a
// broken dispatch is caught before it 404s a whole endpoint in prod.

const EXPECTED = [
  'analyze', 'art', 'art-stream', 'deepzoom', 'fetch',
  'grab', 'iiif', 'sauce', 'scan', 'tile', 'x',
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

  it('404s an unknown op without invoking a handler', async () => {
    const r = res();
    await dispatch({ query: { path: ['totally-unknown'] } } as any, r as any);
    expect(r.statusCode).toBe(404);
    expect(r.body).toMatchObject({ error: expect.stringContaining('totally-unknown') });
  });

  it('404s when no op segment is present', async () => {
    const r = res();
    await dispatch({ query: {} } as any, r as any);
    expect(r.statusCode).toBe(404);
  });

  it('routes a known op to its handler (array path form)', async () => {
    const r = res();
    const spy = vi.spyOn(handlers, 'x').mockResolvedValue(undefined as never);
    await dispatch({ query: { path: ['x'], id: '1' } } as any, r as any);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
