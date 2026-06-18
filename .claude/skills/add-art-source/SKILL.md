---
name: add-art-source
description: Use when adding a new museum/gallery/cultural-heritage source to the Harpe art search (harpe-site). Scaffolds a normalized source adapter in the SOURCES registry plus its tests, following the unified ArtItem contract, and verifies it live.
---

# Add an art source

Integrate a new gallery API into `harpe-site` as a unified `ArtItem` adapter.
Harpe is a pnpm-workspaces monorepo. Source fetchers and the `SOURCES` registry
live in `packages/sources/src/` (`adapters.ts` for fetch functions, `registry.ts`
for the `SOURCES` array). The shared `ArtItem` contract lives in `packages/core`.
The Vercel handler at `src/lib/server/handlers/art.ts` is a thin wrapper — do NOT
write fetchers there.
The full reference is [`docs/ADDING_SOURCES.md`](../../../docs/ADDING_SOURCES.md) — read it first.

## Checklist (create one todo per step)

1. **Confirm the API.** With the user (or from their notes), establish: search
   endpoint (free-text query), how to read thumb + full image URLs from a record,
   auth (keyless vs free key), and the public-domain/license field. Fetch one
   real search response and inspect the JSON before writing code. Do not turn
   research-only candidates into adapters until the endpoint and response shape
   are verified.

2. **Write the fetcher** `export async function fetch<Name>(q): Promise<ArtItem[]>`
   in `packages/sources/src/adapters.ts`, next to the other `fetch*` functions.
   Import helpers from `./helpers.js`: `timedFetch`, `TIMEOUT_MS`, `MAX_ITEMS`,
   `str`, `num`, `fmtFromUrl`, `fmtFromMime`, `iiifImage`, `IIIF`, `UA`, `mapPool`.
   Import types from `@harpe/core`: `import type { ArtItem } from '@harpe/core'`.
   Map EVERY required `ArtItem` field (see the table in the reference); add
   optional enrichment fields when present. Never leave `id`/`title`/`source`
   empty; set `isPublicDomain` from the license field (default `false`).
   Also export it from `packages/sources/src/index.ts`.

3. **Add the key** to the shared `SourceKey` string union in
   `packages/core/src/art-source.ts` (the adapter `key`).

4. **Register** it in the `SOURCES` array in `packages/sources/src/registry.ts`:
   `{ key: '<key>', label: '<Label>', fetch: fetch<Name> }`
   - keyed API → add `requiresEnv: '<ENV_VAR>'` and document it in `SETUP.md`
   - enabled by any of several env vars (dump-backed) → `requiresAnyEnv: [...]`
   - not production-ready → add `disabled: true, note: '…'`

4b. **Add UI metadata** in `src/lib/source-meta.ts`: a `SOURCE_LABELS` entry and a
   `SOURCE_ORDER` entry for the new key. These maps are typed `Record<DisplaySource,
   …>`, so a missing entry fails `pnpm run typecheck` (and `source-meta.test.ts`).

5. **Rebuild @harpe/sources**: `pnpm --filter @harpe/sources build`

6. **Verify deterministically from the repo root**: `pnpm test` — the registry
   guard (`art-sources.test.ts` and `packages/sources/src/sources.test.ts`) checks
   the new key is unique/valid automatically.

7. **Verify live from the repo root**:
   `LIVE_QUERY="<term that should hit this source>" pnpm run test:live`
   The live suite (`sources.live.test.ts`) now covers the source with no extra
   wiring: it must return ≥1 item and EVERY item must pass `validateArtItem`
   (the unified-shape contract). Fix mappings until the per-source test is green.

8. **Typecheck + verify**: `pnpm run typecheck && pnpm run verify`. Commit only
   when the task instructions ask for it.

## Rules

- One adapter = one entry in `SOURCES`. Do not add per-source branches anywhere
  else — `gatherSources`, ranking, streaming and the tests all read the registry.
- Adapters live in `packages/sources/src/adapters.ts` — never in `art.ts`.
- Output MUST be unified `ArtItem`. If `validateArtItem` complains, fix the
  mapping, don't loosen the validator.
- Respect `timedFetch`/`TIMEOUT_MS` so a slow source can't stall the whole search.
- `@harpe/sources` uses `undici` for fetch (not `globalThis.fetch`). Always use
  `timedFetch` from `./helpers.js` rather than calling `fetch` directly.
- If the new source is redundant with Europeana, note it and prefer direct
  coverage only when it adds meaningfully new works.
- OKF/source-research notes are evidence, not an integration spec. OKF can link
  to the `ArtItem` contract but does not replace it.
