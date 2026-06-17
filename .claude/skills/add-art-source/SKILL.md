---
name: add-art-source
description: Use when adding a new museum/gallery/cultural-heritage source to the Harpe art search (harpe-site). Scaffolds a normalized source adapter in the SOURCES registry plus its tests, following the unified ArtItem contract, and verifies it live.
---

# Add an art source

Integrate a new gallery API into `harpe-site` as a unified `ArtItem` adapter.
The full reference is [`docs/ADDING_SOURCES.md`](../../../docs/ADDING_SOURCES.md) — read it first.

## Checklist (create one todo per step)

1. **Confirm the API.** With the user (or from their notes), establish: search
   endpoint (free-text query), how to read thumb + full image URLs from a record,
   auth (keyless vs free key), and the public-domain/license field. Fetch one
   real search response and inspect the JSON before writing code.

2. **Write the fetcher** `async function fetch<Name>(q): Promise<ArtItem[]>` in
   `src/lib/server/handlers/art.ts`, next to the other `fetch*` functions. Use the
   shared helpers `timedFetch`, `TIMEOUT_MS`, `MAX_ITEMS`, `str`, `fmtFromUrl`.
   Map EVERY required `ArtItem` field (see the table in the reference); add
   optional enrichment fields when present. Never leave `id`/`title`/`source`
   empty; set `isPublicDomain` from the license field (default `false`).

3. **Add the key** to the `ArtItem['source']` string union (the adapter `key`).

4. **Register** it in the `SOURCES` array:
   `{ key: '<key>', label: '<Label>', fetch: fetch<Name> }`
   - keyed API → add `requiresEnv: '<ENV_VAR>'` and document it in `SETUP.md`
   - not production-ready → add `disabled: true, note: '…'`

5. **Verify deterministically**: `npm test` — the registry guard
   (`art-sources.test.ts`) checks the new key is unique/valid automatically.

6. **Verify live**: `LIVE_QUERY="<term that should hit this source>" npm run test:live`
   The live suite (`sources.live.test.ts`) now covers the source with no extra
   wiring: it must return ≥1 item and EVERY item must pass `validateArtItem`
   (the unified-shape contract). Fix mappings until the per-source test is green.

7. **Typecheck + verify**: `npm run typecheck && npm run verify`. Commit.

## Rules

- One adapter = one entry in `SOURCES`. Do not add per-source branches anywhere
  else — `gatherSources`, ranking, streaming and the tests all read the registry.
- Output MUST be unified `ArtItem`. If `validateArtItem` complains, fix the
  mapping, don't loosen the validator.
- Respect `timedFetch`/`TIMEOUT_MS` so a slow source can't stall the whole search.
- If the new source is redundant with Europeana, note it and prefer direct
  coverage only when it adds meaningfully new works.
