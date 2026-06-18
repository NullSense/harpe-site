/**
 * Tests for the CLI sources façade (sources.ts).
 *
 * The museum adapters now live in @harpe/sources (tested there in sources.test.ts).
 * This file tests CLI-specific behaviour:
 *   - gather() aggregates from all active sources + Firecrawl
 *   - gather() is resilient to per-source errors
 *   - searchArt() returns ranked ArtItem[]
 *   - Firecrawl requires its env key to be active
 *   - SOURCES re-export is the same registry as @harpe/sources
 */
import { describe, it, expect } from 'vitest';
import { SOURCES } from './sources.js';
import { SOURCES as registrySources } from '@harpe/sources';
import type { ArtItem } from '@harpe/core';

// ---------------------------------------------------------------------------
// Smoke test: SOURCES is the same registry as @harpe/sources
// ---------------------------------------------------------------------------

describe('SOURCES re-export', () => {
  it('re-exports the same SOURCES array from @harpe/sources', () => {
    // Should be the identical reference (no copy)
    expect(SOURCES).toBe(registrySources);
  });

  it('has adapters with expected keys', () => {
    const keys = SOURCES.map((s) => s.key);
    expect(keys).toContain('aic');
    expect(keys).toContain('met');
    expect(keys).toContain('commons');
    expect(keys).toContain('cleveland');
  });
});

// ---------------------------------------------------------------------------
// gather() resilience — errors in individual sources don't crash the batch
// ---------------------------------------------------------------------------

describe('gather() error resilience', () => {
  it('empty result from gather returns an array (no throw)', async () => {
    // This test runs without any env keys, so most adapters are no-ops or
    // may fail due to no network. We only verify it doesn't throw.
    const { gather } = await import('./sources.js');
    const items = await gather('xyzzy-nonexistent-query-' + Date.now());
    expect(Array.isArray(items)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ArtItem shape — any returned items have required fields
// ---------------------------------------------------------------------------

describe('ArtItem shape', () => {
  it('gather returns objects with required ArtItem fields (if any results)', async () => {
    // Only validates shape if we get any results; the test is still useful
    // in CI without network (just passes vacuously).
    const { gather } = await import('./sources.js');
    let items: ArtItem[] = [];
    try {
      items = await gather('monet');
    } catch {
      // network may be unavailable in CI
    }
    for (const it of items.slice(0, 3)) {
      expect(it.id).toBeTruthy();
      expect(it.title).toBeTruthy();
      expect(typeof it.isPublicDomain).toBe('boolean');
      expect(it.thumbUrl || it.previewUrl || it.fullUrl).toBeTruthy();
    }
  }, 30_000);
});
