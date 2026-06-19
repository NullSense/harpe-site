import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ONLY Node's built-in DNS so guardUrl's resolution is deterministic — no
// network, no new deps. Everything else is the real guard code.
vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn() } }));
import dns from 'node:dns/promises';
import { guardUrl, GuardError, clientIp, checkRateLimit, sendGuardError, enforceRateLimit } from './guard.js';

const lookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;
const resolvesTo = (address: string, family: 4 | 6 = 4) => lookup.mockResolvedValue([{ address, family }]);

beforeEach(() => lookup.mockReset());

describe('guardUrl — SSRF protection', () => {
  it('allows a public host and pins the resolved IP', async () => {
    resolvesTo('93.184.216.34');
    const r = await guardUrl('https://example.com/iiif/info.json');
    expect(r.ip).toBe('93.184.216.34');
    expect(r.family).toBe(4);
  });

  it('rejects private / reserved IPv4 ranges', async () => {
    for (const ip of ['10.0.0.5', '172.16.9.9', '192.168.1.1', '127.0.0.1', '169.254.169.254', '0.0.0.0']) {
      resolvesTo(ip);
      await expect(guardUrl(`https://evil.test/`)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('rejects IPv6 loopback and ULA', async () => {
    resolvesTo('::1', 6);
    await expect(guardUrl('https://evil.test/')).rejects.toBeInstanceOf(GuardError);
    resolvesTo('fc00::1', 6);
    await expect(guardUrl('https://evil.test/')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects non-http(s) schemes and odd ports', async () => {
    resolvesTo('93.184.216.34');
    await expect(guardUrl('ftp://example.com/x')).rejects.toMatchObject({ status: 400 });
    await expect(guardUrl('file:///etc/passwd')).rejects.toMatchObject({ status: 400 });
    await expect(guardUrl('https://example.com:8080/x')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects localhost / .local / metadata hostnames before DNS even matters', async () => {
    for (const h of ['http://localhost/', 'http://foo.local/', 'http://metadata/']) {
      await expect(guardUrl(h)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('rejects when the host resolves to no address', async () => {
    lookup.mockResolvedValue([]);
    await expect(guardUrl('https://nope.invalid/')).rejects.toMatchObject({ status: 400 });
  });

  it('blocks if ANY resolved address is private (DNS-rebinding defence)', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(guardUrl('https://sneaky.test/')).rejects.toMatchObject({ status: 403 });
  });
});

describe('clientIp', () => {
  it('prefers x-real-ip (Vercel-set, unforgeable)', () => {
    expect(clientIp({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' })).toBe('1.2.3.4');
    expect(clientIp({ 'x-real-ip': ['1.2.3.4'] })).toBe('1.2.3.4');
  });

  it('falls back to the RIGHTMOST x-forwarded-for hop (closest trusted proxy)', () => {
    // The leftmost entry is client-supplied/spoofable; the rightmost is the one
    // appended by the trusted edge. Using leftmost was a rate-limit bypass.
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })).toBe('5.6.7.8');
    expect(clientIp({ 'x-forwarded-for': ['9.9.9.9, 1.1.1.1'] })).toBe('1.1.1.1');
  });

  it('returns "unknown" when no IP headers are present', () => {
    expect(clientIp({})).toBe('unknown');
  });
});

describe('checkRateLimit (in-memory fallback)', () => {
  it('throws 429 after the window budget is exceeded', () => {
    const ip = `t-${Math.random()}`; // unique bucket per run
    expect(() => { for (let i = 0; i < 30; i++) checkRateLimit(ip); }).not.toThrow();
    expect(() => checkRateLimit(ip)).toThrow(/rate limit/i);
  });
});

// ── shared handler guards (DRY helpers used by every JSON handler) ──────────────

function fakeRes() {
  const r = { headers: {} as Record<string, string>, statusCode: 0, body: undefined as unknown };
  return Object.assign(r, {
    setHeader(k: string, v: string) { r.headers[k] = v; },
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
  });
}
const reqWithIp = (ip: string) => ({ headers: { 'x-real-ip': ip } }) as never;

describe('sendGuardError', () => {
  it('writes a no-store 4xx for a GuardError and returns true', () => {
    const res = fakeRes();
    expect(sendGuardError(res as never, new GuardError(429, 'nope'))).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toEqual({ error: 'nope' });
  });

  it('returns false and writes nothing for a non-GuardError', () => {
    const res = fakeRes();
    expect(sendGuardError(res as never, new Error('boom'))).toBe(false);
    expect(res.statusCode).toBe(0);
    expect(res.body).toBeUndefined();
  });
});

describe('enforceRateLimit', () => {
  it('returns the client IP and writes nothing while under the limit', async () => {
    const res = fakeRes();
    const ip = await enforceRateLimit(reqWithIp('203.0.113.7'), res as never);
    expect(ip).toBe('203.0.113.7');
    expect(res.statusCode).toBe(0);
  });

  it('writes 429 and returns null once the per-IP limit is exhausted', async () => {
    const ip = `enf-${Math.random()}`;
    let res = fakeRes();
    let blocked: string | null = '';
    for (let i = 0; i < 40; i++) { res = fakeRes(); blocked = await enforceRateLimit(reqWithIp(ip), res as never); if (blocked === null) break; }
    expect(blocked).toBeNull();
    expect(res.statusCode).toBe(429);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
