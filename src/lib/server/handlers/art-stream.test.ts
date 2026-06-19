import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the fan-out and the guard before any imports so module-level state
// stays deterministic across tests.
vi.mock('./art.js', () => ({ gatherSources: vi.fn() }));
vi.mock('../guard.js', () => {
  // enforceRateLimit/sendGuardError are composed from the mocked rateLimit/clientIp
  // so existing cases (rateLimit.mockImplementation(throw GuardError)) still drive them.
  class GuardError extends Error {
    constructor(public readonly status: number, message: string) { super(message); this.name = 'GuardError'; }
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

import handler from './art-stream.js';
import { gatherSources } from './art.js';
import { rateLimit, GuardError } from '../guard.js';

// The art-stream handler fires per-source writes and the final done-frame via
// un-awaited promise chains (.then()). `await handler(...)` returns as soon as
// the fan-out is kicked off, but the .write() calls happen in microtasks that
// follow. flushMicrotasks() drains those before assertions.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Minimal response stub (NodeWritable + VercelResponse shape) ─────────────

function makeRes() {
  const r: {
    _status: number;
    _json: unknown;
    headers: Record<string, string>;
    chunks: string[];
    ended: boolean;
    setHeader(k: string, v: string): void;
    status(c: number): typeof r;
    json(body: unknown): typeof r;
    write(chunk: string): boolean;
    end(): void;
  } = {
    _status: 0,
    _json: undefined,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this._status = c; return this; },
    json(body) { this._json = body; return this; },
    write(chunk) { this.chunks.push(chunk); return true; },
    end() { this.ended = true; },
  };
  return r;
}

type Res = ReturnType<typeof makeRes>;

function makeReq(q: string | undefined, method = 'GET', headers: Record<string, string> = {}) {
  return { method, query: q !== undefined ? { q } : {}, headers } as never;
}

// Helper: parse a single SSE frame string into the JSON data payload.
function parseFrame(chunk: string): unknown {
  const m = chunk.match(/^data: (.+)\n\n$/s);
  if (!m) throw new Error(`Not a valid SSE frame: ${JSON.stringify(chunk)}`);
  return JSON.parse(m[1]);
}

// Helper: collect all JSON data payloads from a Res's chunks.
function frames(r: Res): unknown[] {
  return r.chunks.map(parseFrame);
}

const fakeItem = (id = 'aic-1') => ({
  id, title: 'The Night Watch', artist: 'Rembrandt', thumbUrl: 't.jpg',
  previewUrl: 'p.jpg', fullUrl: 'f.jpg', source: 'aic', isPublicDomain: true,
  dimensions: '', format: 'jpeg', lossless: false, downloads: [],
});

beforeEach(() => {
  vi.mocked(gatherSources).mockReset();
  vi.mocked(rateLimit).mockResolvedValue(undefined);
  // Ensure no env key is set so analyzeEnabled is false by default
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

// ─── Method guard ─────────────────────────────────────────────────────────────

describe('art-stream handler — method guard', () => {
  it('returns 405 for POST requests', async () => {
    const r = makeRes();
    await handler(makeReq('monet', 'POST'), r as never);
    expect(r._status).toBe(405);
    expect((r._json as { error: string }).error).toMatch(/method not allowed/i);
  });
});

// ─── Empty query guard ────────────────────────────────────────────────────────

describe('art-stream handler — empty query', () => {
  it('returns 400 for a missing ?q= parameter', async () => {
    const r = makeRes();
    await handler({ method: 'GET', query: {}, headers: {} } as never, r as never);
    expect(r._status).toBe(400);
    expect((r._json as { error: string }).error).toMatch(/missing/i);
    expect(gatherSources).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty ?q= string', async () => {
    const r = makeRes();
    await handler(makeReq('  '), r as never);
    expect(r._status).toBe(400);
    expect(gatherSources).not.toHaveBeenCalled();
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe('art-stream handler — rate limiting', () => {
  it('returns 429 when the rate limit is exceeded', async () => {
    vi.mocked(rateLimit).mockRejectedValue(new GuardError(429, 'Rate limit exceeded — try again in a minute'));
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    expect(r._status).toBe(429);
    expect((r._json as { error: string }).error).toMatch(/rate limit/i);
    expect(gatherSources).not.toHaveBeenCalled();
  });

  it('rethrows a non-GuardError from rateLimit', async () => {
    vi.mocked(rateLimit).mockRejectedValue(new Error('infra failure'));
    const r = makeRes();
    await expect(handler(makeReq('monet'), r as never)).rejects.toThrow('infra failure');
  });
});

// ─── SSE response headers ─────────────────────────────────────────────────────

describe('art-stream handler — SSE headers', () => {
  it('sets text/event-stream content-type', async () => {
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    expect(r.headers['Content-Type']).toBe('text/event-stream');
  });

  it('sets no-cache Cache-Control', async () => {
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    expect(r.headers['Cache-Control']).toBe('no-cache');
  });

  it('sets CORS Access-Control-Allow-Origin: *', async () => {
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

// ─── SSE frame format ─────────────────────────────────────────────────────────

describe('art-stream handler — SSE frame format', () => {
  it('emits a done frame after all sources settle', async () => {
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const last = frames(r).at(-1);
    expect(last).toMatchObject({ done: true });
    expect(r.ended).toBe(true);
  });

  it('emits frames in the SSE "data: ...\\n\\n" format', async () => {
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    // Every chunk must be a valid SSE data frame
    for (const chunk of r.chunks) {
      expect(chunk).toMatch(/^data: .+\n\n$/s);
    }
  });

  it('emits a source-resolved frame with source name and items array', async () => {
    const items = [fakeItem('aic-1')];
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve(items)],
    ] as never);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const sourceFrame = frames(r).find((f: any) => f.source === 'AIC');
    expect(sourceFrame).toBeDefined();
    expect((sourceFrame as any).items).toEqual(items);
  });

  it('emits a source-error frame (not a stream failure) when one source rejects', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.reject(new Error('HTTP 503'))],
      ['Met', Promise.resolve([fakeItem('met-1')])],
    ] as never);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const aicFrame = frames(r).find((f: any) => f.source === 'AIC') as any;
    expect(aicFrame).toBeDefined();
    expect(aicFrame.error).toContain('HTTP 503');
    // Met still resolves normally
    const metFrame = frames(r).find((f: any) => f.source === 'Met') as any;
    expect(metFrame.items).toBeDefined();
  });

  it('stream ends cleanly (done frame + out.end()) even when one source rejects', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.reject(new Error('boom'))],
    ] as never);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const last = frames(r).at(-1);
    expect(last).toMatchObject({ done: true });
    expect(r.ended).toBe(true);
  });
});

// ─── analyzeEnabled flag ──────────────────────────────────────────────────────

describe('art-stream handler — analyzeEnabled flag in done frame', () => {
  it('is false when no AI env keys are set', async () => {
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const done = frames(r).find((f: any) => f.done) as any;
    expect(done.analyzeEnabled).toBe(false);
  });

  it('is true when GEMINI_API_KEY is set', async () => {
    process.env.GEMINI_API_KEY = 'key';
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const done = frames(r).find((f: any) => f.done) as any;
    expect(done.analyzeEnabled).toBe(true);
    delete process.env.GEMINI_API_KEY;
  });

  it('is true when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'key';
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const done = frames(r).find((f: any) => f.done) as any;
    expect(done.analyzeEnabled).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ─── Multi-source fan-out ─────────────────────────────────────────────────────

describe('art-stream handler — multi-source fan-out', () => {
  it('emits one frame per source plus the done frame', async () => {
    vi.mocked(gatherSources).mockResolvedValue([
      ['AIC', Promise.resolve([fakeItem('aic-1')])],
      ['Met', Promise.resolve([fakeItem('met-1')])],
      ['Cleveland', Promise.resolve([fakeItem('cleveland-1')])],
    ] as never);
    const r = makeRes();
    await handler(makeReq('monet'), r as never);
    await flushMicrotasks();
    const fs = frames(r);
    expect(fs.filter((f: any) => f.source)).toHaveLength(3);
    expect(fs.filter((f: any) => f.done)).toHaveLength(1);
  });

  it('passes the trimmed query string to gatherSources', async () => {
    vi.mocked(gatherSources).mockResolvedValue([]);
    const r = makeRes();
    await handler(makeReq('  rembrandt  '), r as never);
    expect(vi.mocked(gatherSources)).toHaveBeenCalledWith('rembrandt');
  });
});
