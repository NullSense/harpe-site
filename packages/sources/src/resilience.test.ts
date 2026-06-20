import { describe, it, expect, beforeEach } from 'vitest';
import type { ArtItem, SourceAdapter } from '@harpe/core';
import { runSource, _resetBreakers, makeDumpHttpPolicy, isBrokenCircuitError } from './resilience.js';
import { DUMP_RETRIES } from './helpers.js';

function adapter(key: string, fetch: SourceAdapter['fetch'], dumpBacked = false): SourceAdapter {
  return { key, label: key, fetch, dumpBacked } as unknown as SourceAdapter;
}
const item = (id: string) => ({ id } as unknown as ArtItem);

beforeEach(() => _resetBreakers());

describe('runSource — per-source circuit breaker', () => {
  it('passes results through when the source is healthy', async () => {
    const a = adapter('healthy', async () => [item('x')]);
    expect(await runSource(a, 'q')).toHaveLength(1);
  });

  it('opens after 4 consecutive failures, then fast-fails to [] without calling fetch', async () => {
    let calls = 0;
    const a = adapter('flaky', async () => { calls++; throw new Error('boom'); });
    // Closed circuit: the first 4 failures propagate (handler surfaces them).
    for (let i = 0; i < 4; i++) {
      await expect(runSource(a, 'q')).rejects.toThrow('boom');
    }
    expect(calls).toBe(4);
    // Open circuit: returns [] immediately, fetch is NOT invoked again.
    expect(await runSource(a, 'q')).toEqual([]);
    expect(await runSource(a, 'q')).toEqual([]);
    expect(calls).toBe(4);
  });

  it('supplies a real timeout AbortSignal to the adapter (unified deadline)', async () => {
    // Capture DURING execution: cockatiel aborts the cooperative signal on
    // completion (timer cleanup), so it reads aborted=true after the await.
    let isSignal = false;
    let abortedDuring: boolean | undefined;
    const a = adapter('sig', async (_q, signal) => {
      isSignal = signal instanceof AbortSignal;
      abortedDuring = signal?.aborted;
      return [item('z')];
    });
    await runSource(a, 'q');
    expect(isSignal).toBe(true);
    expect(abortedDuring).toBe(false); // healthy fast call isn't aborted mid-flight
  });

  it('isolates breakers per source key', async () => {
    const bad = adapter('bad', async () => { throw new Error('x'); });
    for (let i = 0; i < 4; i++) await expect(runSource(bad, 'q')).rejects.toThrow();
    expect(await runSource(bad, 'q')).toEqual([]); // bad is now open
    const good = adapter('good', async () => [item('y')]);
    expect(await runSource(good, 'q')).toHaveLength(1); // unaffected
  });

  it('dump-backed sources bypass the breaker (shared HF policy owns resilience)', async () => {
    let calls = 0;
    const d = adapter('dumpx', async () => { calls++; throw new Error('hf'); }, true);
    for (let i = 0; i < 6; i++) {
      await expect(runSource(d, 'q')).rejects.toThrow('hf');
    }
    expect(calls).toBe(6); // never short-circuited
  });
});

describe('dump HTTP policy — retry + breaker', () => {
  it('retries a transient failure, then succeeds', async () => {
    const p = makeDumpHttpPolicy();
    let n = 0;
    const out = await p.execute(async () => { if (n++ < DUMP_RETRIES) throw new Error('blip'); return 'ok'; });
    expect(out).toBe('ok');
    expect(n).toBe(DUMP_RETRIES + 1); // DUMP_RETRIES transient failures absorbed by retry
  }, 20_000);

  it('exhausts exactly DUMP_RETRIES+1 total attempts before giving up (pins cockatiel maxAttempts = retry count)', async () => {
    // Cockatiel's `maxAttempts` is the RETRY count, not total invocations, so the
    // worst case is (DUMP_RETRIES + 1) attempts. This couples the budget math in
    // helpers.ts to the library's real behavior — if cockatiel's semantics or
    // DUMP_RETRIES drift, DUMP_WORST_CASE_MS / OVERALL_TIMEOUT_MS go stale and the
    // overall deadline could again undercut the dump. That defect must fail here.
    const p = makeDumpHttpPolicy();
    let calls = 0;
    await expect(
      p.execute(async () => { calls++; throw new Error('cold'); }),
    ).rejects.toThrow('cold');
    expect(calls).toBe(DUMP_RETRIES + 1);
  }, 20_000);

  it('opens after sustained failure, then short-circuits without calling through', async () => {
    const p = makeDumpHttpPolicy();
    // Breaker is outermost (ConsecutiveBreaker 5) so it counts whole post-retry
    // operations: five failed executes open it.
    for (let i = 0; i < 5; i++) {
      await expect(p.execute(async () => { throw new Error('down'); })).rejects.toThrow('down');
    }
    let called = false;
    let err: unknown;
    try {
      await p.execute(async () => { called = true; return 'x'; });
    } catch (e) {
      err = e;
    }
    expect(isBrokenCircuitError(err)).toBe(true);
    expect(called).toBe(false); // short-circuited — fn never ran
  }, 30_000);
});
