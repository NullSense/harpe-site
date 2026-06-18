/**
 * Deterministic unit tests for /api/artist + /api/depicts. The entity fetchers and
 * dump search are mocked; no Redis env → handlers take the live (uncached) path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../guard.js', () => ({
  GuardError: class GuardError extends Error {
    status: number;
    constructor(status: number, msg: string) { super(msg); this.status = status; this.name = 'GuardError'; }
  },
  rateLimit: vi.fn(),
  clientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));

vi.mock('@harpe/sources', () => ({
  fetchArtistEntity: vi.fn(),
  fetchArtistWorkIds: vi.fn(),
  fetchSubjectEntity: vi.fn(),
  fetchDumpSearch: vi.fn(),
}));

import { fetchArtistEntity, fetchArtistWorkIds, fetchSubjectEntity, fetchDumpSearch } from '@harpe/sources';
import artistHandler from './artist.js';
import depictsHandler from './depicts.js';

const mArtist = fetchArtistEntity as ReturnType<typeof vi.fn>;
const mWorkIds = fetchArtistWorkIds as ReturnType<typeof vi.fn>;
const mSubject = fetchSubjectEntity as ReturnType<typeof vi.fn>;
const mSearch = fetchDumpSearch as ReturnType<typeof vi.fn>;

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
    mArtist.mockResolvedValue(null); mWorkIds.mockResolvedValue([]);
    const res = makeRes();
    await artistHandler(makeReq({ qid: 'Q999' }) as never, res as never);
    expect(res._status()).toBe(404);
  });
  it('200 with entity + works filtered to the known work-id set', async () => {
    process.env.HARPE_DUMP_DATASET = 'owner/ds';
    mArtist.mockResolvedValue({ qid: 'Q41406', labelEn: 'Claude Monet', workCount: 2 });
    mWorkIds.mockResolvedValue(['wd-Q1', 'wd-Q2']);
    mSearch.mockResolvedValue([{ id: 'wd-Q1', title: 'A' }, { id: 'wd-Q9', title: 'Other' }]);
    const res = makeRes();
    await artistHandler(makeReq({ qid: 'Q41406' }) as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._body() as { entity: { labelEn: string }; works: unknown[] };
    expect(body.entity.labelEn).toBe('Claude Monet');
    expect(body.works).toHaveLength(1); // wd-Q9 filtered out (not in work-id set)
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
  it('200 with works exact-matched on the depicts QID (no substring collision)', async () => {
    process.env.HARPE_DUMP_DATASET = 'owner/ds';
    mSubject.mockResolvedValue({ qid: 'Q146', labelEn: 'cat', workCount: 1 });
    mSearch.mockResolvedValue([
      { id: 'a', depicts: ['Q146'] },
      { id: 'b', depicts: ['Q1460'] }, // substring-similar but distinct → excluded
      { id: 'c', depicts: ['Q5'] },
    ]);
    const res = makeRes();
    await depictsHandler(makeReq({ qid: 'Q146' }) as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._body() as { works: { id: string }[] };
    expect(body.works.map((w) => w.id)).toEqual(['a']);
  });
});
