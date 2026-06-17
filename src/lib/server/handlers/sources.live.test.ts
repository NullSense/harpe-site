import { describe, it, expect } from 'vitest';
import { validateArtItem } from '@harpe/core';
import { activeSources } from './art.js';

/**
 * LIVE integration test: hits each active source's real API and asserts it
 * (a) returns results and (b) every item conforms to the unified ArtItem shape.
 *
 * Skipped by default (network = slow/flaky in CI). Run it explicitly:
 *   pnpm run test:live          # or: RUN_LIVE=1 vitest run --project live
 *   LIVE_QUERY="monet" RUN_LIVE=1 vitest run sources.live
 * Keyed sources only run when their key/env is present.
 */
const LIVE = !!process.env.RUN_LIVE;
const QUERY = process.env.LIVE_QUERY || 'portrait';

describe.skipIf(!LIVE)(`live sources (query="${QUERY}")`, () => {
  for (const s of activeSources()) {
    it(`${s.label} → returns ≥1 item, all unified-valid`, async () => {
      const items = await s.fetch(QUERY);
      expect(Array.isArray(items), `${s.label} did not return an array`).toBe(true);
      const bad = items.flatMap((it) => validateArtItem(it).map((p) => `${it.id || '?'}: ${p}`));
      expect(bad, `unified-shape violations:\n  ${bad.slice(0, 8).join('\n  ')}`).toEqual([]);
      expect(items.length, `${s.label} returned 0 results for "${QUERY}"`).toBeGreaterThan(0);
    }, 30_000);
  }
});
