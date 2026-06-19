import { describe, it, expect } from 'vitest';
import { validateArtItem, type ArtItem } from '@harpe/core';

/**
 * LIVE SMOKE TEST against the DEPLOYED site — proves the knowledge-graph pipeline
 * is wired end-to-end in production: every search returns unified-valid cards, the
 * artist-entity link reaches the result set (Stage 1), works carry KG identity
 * (artist_qid / wikidataId / nb_sitelinks — Stage 2 + enrichment), and dedupe()
 * collapsed duplicates (no repeated ids; dupCount surfaced).
 *
 * Skipped by default. Run after a deploy:
 *   RUN_LIVE=1 pnpm vitest run --project live src/lib/server/handlers/kg.live
 *   HARPE_SMOKE_URL=https://harpe-site.vercel.app RUN_LIVE=1 pnpm run test:live
 *
 * Lenient by design (an HF re-index can briefly thin dump results) but each
 * assertion still proves the KG plumbing is live, not just that the API responds.
 */
const LIVE = !!process.env.RUN_LIVE;
const BASE = process.env.HARPE_SMOKE_URL || 'https://harpe-site.vercel.app';
// Famous, well-enriched artists — broad enough that KG coverage must show up.
const QUERIES = (process.env.HARPE_SMOKE_QUERIES || 'Rembrandt,Claude Monet,Hokusai').split(',');

async function fetchArt(q: string): Promise<ArtItem[]> {
  const res = await fetch(`${BASE}/api/art?q=${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': 'harpe-kg-smoke' },
    signal: AbortSignal.timeout(70_000),
  });
  expect(res.ok, `GET /api/art?q=${q} → HTTP ${res.status}`).toBe(true);
  const body = (await res.json()) as { items?: ArtItem[] };
  return body.items ?? [];
}

describe.skipIf(!LIVE)(`KG smoke — deployed ${BASE}`, () => {
  for (const q of QUERIES) {
    describe(`q="${q}"`, () => {
      it('returns unified-valid cards with the KG linked end-to-end', async () => {
        const items = await fetchArt(q);
        expect(items.length, `0 results for "${q}"`).toBeGreaterThan(0);

        // 1) Unified shape — every card conforms to the ArtItem contract.
        const bad = items.flatMap((it) => validateArtItem(it).map((p) => `${it.id || '?'}: ${p}`));
        expect(bad, `unified-shape violations:\n  ${bad.slice(0, 8).join('\n  ')}`).toEqual([]);

        // 2) De-duplication — dedupe() ran: no repeated ids in the result set.
        const ids = items.map((it) => it.id);
        expect(new Set(ids).size, 'duplicate ids in results (dedupe did not run)').toBe(ids.length);

        // 3) Entity linking (Stage 1) — the artist→QID link reached the cards. For a
        //    famous artist a healthy fraction must carry an artistId regardless of
        //    which sources answered.
        const linked = items.filter((it) => it.artistId).length;
        expect(linked, `no artist-entity links for "${q}" (Stage 1 not wired)`).toBeGreaterThan(0);

        // 4) KG identity / enrichment — at least one card carries a work-level signal
        //    (wikidataId from work_index/SDC, or nb_sitelinks from enrichment).
        const enriched = items.some((it) => it.wikidataId || (it.nbSitelinks ?? 0) > 0);
        expect(enriched, `no work-level KG (wikidataId/nb_sitelinks) for "${q}"`).toBe(true);
      }, 90_000);
    });
  }
});
