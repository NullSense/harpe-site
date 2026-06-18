/**
 * Resilience layer (cockatiel) for the source fan-out.
 *
 * Per-source circuit breakers stop a degraded upstream from taxing every search:
 * once a source fails repeatedly its circuit opens and we return [] instantly for
 * a cooldown instead of paying the upstream timeout on every query — so one slow/
 * down museum API can't blow the whole search's p95/p99 latency.
 *
 * Breaker state lives in module-level policy instances, so it persists across
 * requests for the life of a warm serverless instance (Vercel reuses the module
 * between invocations). It's a per-instance latency optimizer, not a global
 * correctness mechanism — each instance independently learns which upstreams are
 * down. That's the documented serverless model for cockatiel.
 */
import {
  circuitBreaker, handleAll, ConsecutiveBreaker, ExponentialBackoff,
  retry, timeout, TimeoutStrategy, wrap, isBrokenCircuitError,
} from 'cockatiel';
import type { ArtItem, SourceAdapter } from '@harpe/core';
import { TIMEOUT_MS } from './helpers.js';

export { isBrokenCircuitError };

// Open a source's circuit after this many consecutive failures; probe again after
// an exponential backoff (10s → 60s). Tuned for ~20 flaky museum APIs at low RPS,
// where a sampling/rate breaker has too little traffic to be meaningful.
const CONSECUTIVE_FAILURES = 4;

type Breaker = ReturnType<typeof circuitBreaker>;
const breakers = new Map<string, Breaker>();

/** The memoized circuit breaker for a source key (state persists per instance). */
export function sourceBreaker(key: string): Breaker {
  let b = breakers.get(key);
  if (!b) {
    b = circuitBreaker(handleAll, {
      halfOpenAfter: new ExponentialBackoff({ initialDelay: 10_000, maxDelay: 60_000 }),
      breaker: new ConsecutiveBreaker(CONSECUTIVE_FAILURES),
    });
    breakers.set(key, b);
  }
  return b;
}

// Per-source policy = breaker (outer) + cooperative timeout (inner). The timeout
// owns the deadline and supplies the AbortSignal the adapter fetches with — one
// place to tune, replacing 17 hand-rolled AbortController+setTimeout blocks. A
// timeout counts as a breaker failure, so a persistently slow source trips open.
function makePolicy(key: string) {
  return wrap(sourceBreaker(key), timeout(TIMEOUT_MS, TimeoutStrategy.Cooperative));
}
const policies = new Map<string, ReturnType<typeof makePolicy>>();

/** The memoized breaker+timeout policy for a source key. */
export function sourcePolicy(key: string): ReturnType<typeof makePolicy> {
  let p = policies.get(key);
  if (!p) {
    p = makePolicy(key);
    policies.set(key, p);
  }
  return p;
}

/**
 * Run one source's fetch through its circuit breaker.
 *
 * - Breaker CLOSED: a thrown error propagates (handler still surfaces it as a
 *   warning) and counts toward opening the circuit.
 * - Breaker OPEN: returns [] immediately — fast, quiet degradation while the
 *   source recovers, instead of a per-query timeout + warning.
 *
 * Dump-backed sources bypass this: they share one HF /search call that carries
 * its own retry + breaker (dumpHttpPolicy in adapters.ts), so a per-source live
 * breaker would double-count one endpoint.
 */
export async function runSource(s: SourceAdapter, q: string): Promise<ArtItem[]> {
  if (s.dumpBacked) return s.fetch(q);
  try {
    return await sourcePolicy(s.key).execute(({ signal }) => s.fetch(q, signal));
  } catch (e) {
    if (isBrokenCircuitError(e)) return [];
    throw e;
  }
}

/** Reset all breaker state — for tests so cases don't bleed into each other. */
export function _resetBreakers(): void {
  breakers.clear();
  policies.clear();
}

// ─── Dump-backed HF /search policy ────────────────────────────────────────────
// All 9 dump sources share ONE Hugging Face /search call per query. Protect it as
// a unit: a per-attempt cooperative timeout, a fast retry so a transient HF blip
// doesn't wipe out every dump source for a query, behind a breaker so a sustained
// HF outage fails fast instead of paying the cold-index wait on every search.
//
// Order = wrap(breaker, retry, timeout): breaker is outermost, so it counts whole
// (post-retry) operations — retry absorbs transient blips, the breaker only trips
// on a sustained outage, and when open it short-circuits WITHOUT spending retries.
const DUMP_TIMEOUT_MS = 14_000;

export function makeDumpHttpPolicy() {
  return wrap(
    circuitBreaker(handleAll, {
      halfOpenAfter: new ExponentialBackoff({ initialDelay: 5_000, maxDelay: 30_000 }),
      breaker: new ConsecutiveBreaker(5),
    }),
    retry(handleAll, { maxAttempts: 3, backoff: new ExponentialBackoff({ initialDelay: 200, maxDelay: 2_000 }) }),
    timeout(DUMP_TIMEOUT_MS, TimeoutStrategy.Cooperative),
  );
}

/** Shared policy instance for the HF /search call (state persists per instance). */
export const dumpHttpPolicy = makeDumpHttpPolicy();
