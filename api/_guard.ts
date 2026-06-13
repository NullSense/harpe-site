/**
 * SSRF guard — shared by scan.ts and fetch.ts.
 *
 * Blocks:
 *  - Non-http/https schemes
 *  - Non-standard ports (only 80 and 443 allowed; empty port = standard)
 *  - Hostnames that resolve to private/reserved IP space or special names
 *    (localhost, *.local, metadata service 169.254.169.254, etc.)
 *
 * IPv4 private ranges blocked:
 *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
 *   169.254.0.0/16 (link-local + cloud metadata), 0.0.0.0/8
 *
 * IPv6 blocked:
 *   ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local)
 *
 * Call guardUrl() before every outbound request, and after each redirect hop
 * (pass the Location header through it before following). The fetch helpers in
 * scan.ts and fetch.ts use redirect:'manual' and call this on each hop.
 */

import dns from 'node:dns/promises';
import { Agent } from 'undici';

// ─── Types ───────────────────────────────────────────────────────────────────

export class GuardError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GuardError';
  }
}

// ─── IPv4 checks ─────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  return parts.reduce((acc, p) => (acc << 8) | parseInt(p, 10), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = bits ? (~0 << (32 - parseInt(bits, 10))) >>> 0 : 0xffffffff;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local + AWS/GCP/Azure metadata: 169.254.169.254
  '0.0.0.0/8',
];

function isPrivateIPv4(ip: string): boolean {
  return BLOCKED_V4_CIDRS.some((cidr) => inCidr(ip, cidr));
}

// ─── IPv6 checks ─────────────────────────────────────────────────────────────

function ipv6ToBytes(ip: string): number[] {
  // Expand :: and parse into 16 bytes
  const [left, right = ''] = ip.split('::');
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  const groups = [
    ...leftGroups,
    ...Array(missing).fill('0'),
    ...rightGroups,
  ].map((g) => parseInt(g || '0', 16));
  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >> 8) & 0xff, g & 0xff);
  }
  return bytes;
}

function isPrivateIPv6(ip: string): boolean {
  // Strip zone id (e.g. fe80::1%eth0)
  const clean = ip.replace(/%.*$/, '').toLowerCase();

  // Loopback: ::1
  if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;

  // Unspecified: ::
  if (clean === '::' || clean === '') return true;

  try {
    const bytes = ipv6ToBytes(clean);

    // fc00::/7 — Unique Local (fc00–fdff)
    if ((bytes[0] & 0xfe) === 0xfc) return true;

    // fe80::/10 — Link-Local (fe80–febf)
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;

    // ::ffff:0:0/96 — IPv4-mapped; check the embedded v4 part
    const isMapped =
      bytes.slice(0, 10).every((b) => b === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;
    if (isMapped) {
      const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      if (isPrivateIPv4(v4)) return true;
    }
  } catch {
    // Malformed — treat as blocked
    return true;
  }

  return false;
}

// ─── Hostname keyword blocks ──────────────────────────────────────────────────

const BLOCKED_HOSTNAME_RE = /^localhost$|\.local$|^metadata$/i;

// ─── Main guard ───────────────────────────────────────────────────────────────

const ALLOWED_PORTS = new Set(['', '80', '443']);

/**
 * Validate a URL for safe outbound fetching.
 * Throws GuardError on any violation.
 * Returns the validated URL plus the resolved IP to PIN the connection to —
 * pass it to pinnedAgent() so the socket connects to the exact IP we validated,
 * closing the DNS-rebinding TOCTOU window between this check and fetch()'s own
 * (otherwise separate) DNS resolution.
 */
export async function guardUrl(raw: string): Promise<{ url: string; ip: string; family: 4 | 6 }> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GuardError(400, 'Invalid URL');
  }

  // 1. Scheme
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GuardError(400, 'Only http and https URLs are allowed');
  }

  // 2. Port
  if (!ALLOWED_PORTS.has(parsed.port)) {
    throw new GuardError(403, `Non-standard port ${parsed.port} is not allowed`);
  }

  // 3. Hostname keyword blocks
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_RE.test(hostname)) {
    throw new GuardError(403, 'Blocked host');
  }

  // 4. DNS resolution — check every returned address
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new GuardError(400, 'Could not resolve host');
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      throw new GuardError(403, 'Blocked host (private IP range)');
    }
    if (family === 6 && isPrivateIPv6(address)) {
      throw new GuardError(403, 'Blocked host (private IPv6 range)');
    }
  }

  // Pin to the first validated address (every address was checked above).
  const first = addresses[0];
  if (!first) throw new GuardError(400, 'Could not resolve host');
  return { url: parsed.toString(), ip: first.address, family: first.family as 4 | 6 };
}

/**
 * An undici Agent that connects ONLY to the given pre-validated IP, regardless
 * of what the hostname would resolve to at connect time (TLS SNI/cert validation
 * still uses the URL hostname). Build one per request/redirect hop from the IP
 * that guardUrl() returned, and pass it as fetch's `dispatcher`.
 */
export function pinnedAgent(ip: string, family: 4 | 6): Agent {
  // Node/undici may call lookup in scalar form (err, address, family) or, when
  // options.all is set, array form (err, [{address, family}]). Honor both so the
  // connection actually dials the pinned IP instead of erroring.
  const lookup = (
    _hostname: string,
    options: { all?: boolean } | undefined,
    cb: (err: null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ) => {
    if (options && options.all) cb(null, [{ address: ip, family }]);
    else cb(null, ip, family);
  };
  return new Agent({ connect: { lookup: lookup as never } });
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// Two-tier: Upstash Redis sliding-window (cross-instance, durable) when env
// vars are set; falls back to best-effort in-memory limiter otherwise.

// ── In-memory fallback ──────────────────────────────────────────────────────
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 30;  // per IP per window (in-memory fallback)

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(ip: string): void {
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    return;
  }

  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS) {
    throw new GuardError(429, 'Rate limit exceeded — try again in a minute');
  }
}

// ── Upstash Redis sliding-window (optional, cross-instance) ─────────────────
// Lazy singleton — created once on first call when env vars are present.
// Importing dynamically keeps the module loadable even when the packages are
// absent from node_modules (they are always present after `npm install`, but
// this pattern prevents startup crashes if env vars are missing).

let _upstashRatelimit: { limit: (key: string) => Promise<{ success: boolean }> } | null | undefined;
// undefined = not yet initialised; null = no env vars (fallback mode)

async function getUpstashRatelimit() {
  if (_upstashRatelimit !== undefined) return _upstashRatelimit;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    _upstashRatelimit = null;
    return null;
  }

  try {
    // Dynamic imports so the module still loads when the packages are absent
    const { Ratelimit } = await import('@upstash/ratelimit');
    const { Redis } = await import('@upstash/redis');

    const redis = new Redis({ url, token });
    _upstashRatelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '60 s'),
      analytics: false,
    });
  } catch {
    // Package missing or misconfigured — degrade to in-memory
    _upstashRatelimit = null;
  }

  return _upstashRatelimit;
}

/**
 * Async rate limiter that uses Upstash Redis when configured (cross-instance,
 * durable) and falls back to the in-memory checkRateLimit otherwise.
 * Throws GuardError(429) when the limit is exceeded.
 */
export async function rateLimit(ip: string): Promise<void> {
  const limiter = await getUpstashRatelimit();

  if (limiter) {
    const { success } = await limiter.limit(ip);
    if (!success) {
      throw new GuardError(429, 'Rate limit exceeded — try again in a minute');
    }
    return;
  }

  // Fallback: synchronous in-memory limiter
  checkRateLimit(ip);
}

/** Extract best-effort client IP from Vercel request headers. */
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length) {
    return xff[0].split(',')[0].trim();
  }
  return 'unknown';
}
