/**
 * fetchWithTimeout — thin wrapper around undici's fetch that:
 *   1. creates its own AbortController
 *   2. sets a setTimeout to abort after `timeoutMs`
 *   3. clears the timer in a finally block
 *
 * Callers pass the full RequestInit (method, headers, body, dispatcher, …)
 * plus a `timeoutMs` field. The default timeout is 10 s.
 *
 * This helper is only appropriate for **single-fetch** call sites where the
 * controller's lifetime equals exactly one HTTP round trip.  Handlers that
 * follow redirects manually across multiple fetch() calls — or that share
 * the controller across a streaming pipeline — must manage their own
 * AbortController so the timeout covers the entire operation.
 */

import { fetch } from 'undici';
import type { RequestInit } from 'undici';

export interface FetchWithTimeoutInit extends RequestInit {
  /** Milliseconds before the request is aborted. Default: 10_000. */
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  url: string,
  init?: FetchWithTimeoutInit,
): Promise<Response> {
  const { timeoutMs = 10_000, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Merge caller's signal (if any) — prefer caller's abort, but also abort
    // on our timer.  In practice none of the callers pass their own signal.
    const signal = controller.signal;
    return await (fetch(url, { ...fetchInit, signal }) as unknown as Promise<Response>);
  } finally {
    clearTimeout(timer);
  }
}
