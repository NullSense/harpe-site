import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('undici', () => ({ fetch: vi.fn() }));
import { fetch } from 'undici';
import handler from './grab.js';

const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });

interface Res { _status: number; _json: unknown; setHeader: (k: string, v: string) => void; status: (c: number) => Res; json: (o: unknown) => Res; }
function mockRes(): Res {
  const res = { _status: 200, _json: null } as Res;
  res.setHeader = () => {};
  res.status = (c) => { res._status = c; return res; };
  res.json = (o) => { res._json = o; return res; };
  return res;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (url: string) => { const res = mockRes(); return handler({ method: 'GET', query: { url }, headers: {} } as any, res as any).then(() => res); };

beforeEach(() => { mockFetch.mockReset(); process.env.COBALT_API_URL = 'https://cobalt.test'; });

describe('/api/grab (cobalt relay)', () => {
  it('is inert (501) when COBALT_API_URL is unset', async () => {
    delete process.env.COBALT_API_URL;
    const res = await call('https://youtube.com/watch?v=x');
    expect(res._status).toBe(501);
    expect((res._json as { configured?: boolean }).configured).toBe(false);
  });

  it('normalizes a tunnel/redirect response to media[]', async () => {
    mockFetch.mockResolvedValue(ok({ status: 'tunnel', url: 'https://cobalt.test/t/abc.mp4', filename: 'clip.mp4' }));
    const res = await call('https://tiktok.com/@a/video/1');
    expect(res._status).toBe(200);
    expect((res._json as { media: Array<{ type: string; url: string }> }).media[0]).toMatchObject({ type: 'video', url: 'https://cobalt.test/t/abc.mp4' });
  });

  it('expands a picker response', async () => {
    mockFetch.mockResolvedValue(ok({ status: 'picker', picker: [{ type: 'photo', url: 'https://c/1.jpg' }, { type: 'video', url: 'https://c/2.mp4' }] }));
    const res = await call('https://instagram.com/p/x');
    expect((res._json as { media: unknown[] }).media).toHaveLength(2);
  });

  it('hands off local-processing (needs client merge) with 422', async () => {
    mockFetch.mockResolvedValue(ok({ status: 'local-processing', tunnel: ['x'] }));
    const res = await call('https://youtube.com/watch?v=x');
    expect(res._status).toBe(422);
  });

  it('rejects a non-http url with 400', async () => {
    const res = await call('ftp://nope');
    expect(res._status).toBe(400);
  });
});
