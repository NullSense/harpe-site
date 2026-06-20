/**
 * Deterministic unit tests for /api/artist + /api/depicts. The entity fetchers and
 * dump search are mocked; no Redis env → handlers take the live (uncached) path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../guard.js', () => {
  // enforceRateLimit/sendGuardError are composed from the mocked rateLimit/clientIp
  // so existing cases (rateLimit.mockImplementation(throw GuardError)) still drive them.
  class GuardError extends Error {
    status: number;
    constructor(status: number, msg: string) { super(msg); this.status = status; this.name = 'GuardError'; }
  }
  const rateLimit = vi.fn();
  const clientIp = vi.fn(() => '1.2.3.4');
  const sendGuardError = (res: { setHeader(k: string, v: string): void; status(c: number): { json(b: unknown): unknown } }, e: unknown) => {
    if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); res.status(e.status).json({ error: e.message }); return true; }
    return false;
  };
  const enforceRateLimit = vi.fn(async (_req: { headers: Record<string, unknown> }, res: { setHeader(k: string, v: string): void; status(c: number): { json(b: unknown): unknown } }) => {
    const ip = clientIp();
    try { await rateLimit(ip); return ip; } catch (e) { if (sendGuardError(res, e)) return null; throw e; }
  });
  return { GuardError, rateLimit, clientIp, sendGuardError, enforceRateLimit };
});

// The handlers call the shared page loaders (loadArtistPage / loadSubjectPage); the
// entity+works COMPOSITION is covered in orchestrate.test.ts, so here we mock at that
// boundary and test only the handler wiring (404 on null, 200 passthrough).
vi.mock('@harpe/sources', () => ({
  loadArtistPage: vi.fn(),
  loadSubjectPage: vi.fn(),
}));

import { loadArtistPage, loadSubjectPage } from '@harpe/sources';
import artistHandler from './artist.js';
import depictsHandler from './depicts.js';

const mArtist = loadArtistPage as ReturnType<typeof vi.fn>;
const mSubject = loadSubjectPage as ReturnType<typeof vi.fn>;

function makeReq(query: Record<string, string> = {}, method = 'GET') {
  return { method, query, headers: {}, url: '/api/artist' };
}
function makeRes() {
  let statusCode = 200; let body: unknown;
  const res = {
    setHeader: () => {},
    status: (c: number) => { statusCode = c; return res; },
    json: (d: unknown) => { body = d; return res; },
    _status: () => statusCode,
    _body: () => body,
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
  delete process.env.HARPE_DUMP_DATASET;
});

describe('/api/artist', () => {
  it('405 on non-GET', async () => {
    const res = makeRes();
    await artistHandler(makeReq({ qid: 'Q1' }, 'POST') as never, res as never);
    expect(res._status()).toBe(405);
  });
  it('400 on missing/invalid qid', async () => {
    const res = makeRes();
    await artistHandler(makeReq({ qid: 'not-a-qid' }) as never, res as never);
    expect(res._status()).toBe(400);
  });
  it('404 when the artist is not in the index', async () => {
    mArtist.mockResolvedValue(null);
    const res = makeRes();
    await artistHandler(makeReq({ qid: 'Q999' }) as never, res as never);
    expect(res._status()).toBe(404);
  });
  it('200 passes the loaded artist page through', async () => {
    mArtist.mockResolvedValue({ entity: { qid: 'Q41406', labelEn: 'Claude Monet', workCount: 2 }, works: [{ id: 'wd-Q1' }] });
    const res = makeRes();
    await artistHandler(makeReq({ qid: 'Q41406' }) as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._body() as { entity: { labelEn: string }; works: unknown[] };
    expect(body.entity.labelEn).toBe('Claude Monet');
    expect(body.works).toHaveLength(1);
    expect(mArtist).toHaveBeenCalledWith('Q41406');
  });
});

describe('/api/depicts', () => {
  it('400 on invalid qid', async () => {
    const res = makeRes();
    await depictsHandler(makeReq({ qid: 'x' }) as never, res as never);
    expect(res._status()).toBe(400);
  });
  it('404 when subject not found', async () => {
    mSubject.mockResolvedValue(null);
    const res = makeRes();
    await depictsHandler(makeReq({ qid: 'Q999' }) as never, res as never);
    expect(res._status()).toBe(404);
  });
  it('200 passes the loaded subject page through', async () => {
    mSubject.mockResolvedValue({ entity: { qid: 'Q146', labelEn: 'cat', workCount: 1 }, works: [{ id: 'a' }] });
    const res = makeRes();
    await depictsHandler(makeReq({ qid: 'Q146' }) as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._body() as { works: { id: string }[] };
    expect(body.works.map((w) => w.id)).toEqual(['a']);
    expect(mSubject).toHaveBeenCalledWith('Q146');
  });
});
