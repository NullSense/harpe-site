import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ONLY Node's built-in DNS so guardUrl's resolution is deterministic — no
// network, no new deps. Everything else is the real guard code.
vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn() } }));
import dns from 'node:dns/promises';
import { guardUrl, GuardError, clientIp, checkRateLimit } from './guard.js';

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
  it('takes the first x-forwarded-for hop', () => {
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })).toBe('1.2.3.4');
    expect(clientIp({ 'x-forwarded-for': ['9.9.9.9, 1.1.1.1'] })).toBe('9.9.9.9');
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
