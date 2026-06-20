import { describe, it, expect } from 'vitest';
import {
  TIMEOUT_MS,
  DUMP_TIMEOUT_MS,
  DUMP_RETRIES,
  DUMP_BACKOFF_MAX_MS,
  DUMP_WORST_CASE_MS,
  OVERALL_TIMEOUT_MS,
} from './helpers.js';

// The unified search timing budget. These constants are the single source of
// truth shared by the live per-source timeout (resilience.sourcePolicy), the
// dump HF /filter policy (resilience.makeDumpHttpPolicy) and the streaming /
// batch overall deadline (art-stream OVERALL_TIMEOUT_MS). The invariants below
// guard a real defect that shipped: OVERALL_TIMEOUT_MS (9s) was LESS than the
// dump worst case, so on a cold HF index the stream ended before the dump-backed
// sources — the bulk of the best results — could land.
//
// NOTE on DUMP_RETRIES: cockatiel's retry `maxAttempts` is the number of RETRIES,
// NOT total invocations — total attempts = DUMP_RETRIES + 1. The worst-case math
// must use (DUMP_RETRIES + 1) or it undercounts by a whole attempt (the bug a
// first cut of this change still had). resilience.test.ts pins this against the
// real library behavior so the formula here can never drift from cockatiel again.
describe('search timing budget invariants', () => {
  it('computes the dump worst case from total attempts + backoff gaps (not a tautology)', () => {
    // total wall time = (initial + retries) attempts × per-attempt timeout
    //                 + one max backoff per retry gap.
    expect(DUMP_WORST_CASE_MS).toBe(
      DUMP_TIMEOUT_MS * (DUMP_RETRIES + 1) + DUMP_RETRIES * DUMP_BACKOFF_MAX_MS,
    );
  });

  it('never lets the overall deadline cut off the dump mid-flight', () => {
    // THE regression: the overall budget must cover the dump's worst case so the
    // stream/batch never ends with the best results still pending.
    expect(OVERALL_TIMEOUT_MS).toBeGreaterThanOrEqual(DUMP_WORST_CASE_MS);
  });

  it('gives live sources a tighter deadline than the dump (live is supplementary)', () => {
    expect(TIMEOUT_MS).toBeLessThan(DUMP_WORST_CASE_MS);
  });

  it('stays well under the Vercel function maxDuration (60s)', () => {
    expect(OVERALL_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
