# Adding a museum / gallery source

Every art source is one **adapter** in the `SOURCES` registry. Add one entry and
search, ranking, streaming, the unified-shape validator and the live test pick it
up automatically. There is exactly one place to add a gallery.

Harpe is now a pnpm-workspaces monorepo. The source fetchers and `SOURCES`
registry live in the repo-root web/API app at `src/lib/server/handlers/art.ts`;
the shared `ArtItem`, `SourceAdapter`, and `validateArtItem` contract lives in
`packages/core/src/art-source.ts`; the browser extension lives under
`apps/extension`. Adding a source should not require source-specific branches in
the extension or other callers.

## Research gate

Do not add an adapter from catalog notes alone. Before writing code, confirm the
source has a usable search endpoint, auth model, image URL fields, license/public
domain fields, and terms that allow the planned access. Inspect at least one real
JSON response and map it to the `ArtItem` contract below.

Candidate/source-routing notes currently worth documenting:

- Europeana is the primary machine-readable route for countries whose major
  institutions expose only human portals. The adapter runs the pan-European base
  query first and only fans out country-focused queries (Lithuania, Poland, Spain,
  Portugal and ~25 more) when the base is sparse, then dedupes by record id —
  recall when it helps, no wasted fan-out when the base already answers the query.
- Wikimedia Commons, Wikidata and SMK are already first-class sources; do not add
  duplicate adapters for them.
- Rijksmuseum: keyless Linked Art search exists at
  `https://data.rijksmuseum.nl/search/collection`, but it returns identifiers
  and the IIIF host was not reachable from this environment. Keep it conditional
  until IIIF image delivery is verified from the deployment/server environment.
- Lithuania LIMIS, Poland Zacheta/MNW, Spain Prado/BNE/Hispana, and Portugal
  MatrizNet/BNP/Gulbenkian were researched as mostly human portals or unstable /
  blocked endpoints. Prefer Europeana/Wikidata/Commons coverage unless a current
  documented machine API is verified with real responses.

Research notes may move to an OKF-style knowledge directory later; see
`docs/OKF_MIGRATION.md`. OKF notes do not replace this adapter contract.

## The unified item (`ArtItem`)

Your adapter's job: turn the source's API response into `ArtItem[]`. The shape
(defined in `packages/core/src/art-source.ts`):

| Field | Req | Notes |
|---|---|---|
| `id` | ✅ | globally unique — prefix with your key, e.g. `` `prado-${objId}` `` |
| `title` | ✅ | artwork title (fallback to a sensible default, never empty) |
| `source` | ✅ | your adapter `key` (must be added to the shared `SourceKey` union) |
| `thumbUrl` / `previewUrl` / `fullUrl` | ✅ (≥1) | http(s) image URLs; raw museum/CDN URLs are fine (the client proxies http→https) |
| `artist`, `dimensions`, `format`, `lossless`, `downloads`, `isPublicDomain` | ✅ | always set (`format`/`lossless` from the file; `downloads` may be `[]`) |
| `width`, `height`, `date`, `medium`, `culture`, `creditLine`, `description`, `sourceUrl` | ◻️ | enrichment — include when the API provides them |

Run `validateArtItem(item)` (it returns a list of problems; `[]` = valid). The
live test asserts `[]` for every item your adapter returns.

## Steps

1. **Write the fetcher** in `art.ts` (use the shared helpers):
   ```ts
   async function fetchPrado(q: string): Promise<ArtItem[]> {
     const controller = new AbortController();
     const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
     try {
       const url = `https://api.example.org/search?q=${encodeURIComponent(q)}`;
       const res = await timedFetch(url, controller.signal);
       if (!res.ok) throw new Error(`HTTP ${res.status}`);
       const json = await res.json() as { records?: Array<Record<string, unknown>> };
       return (json.records ?? []).slice(0, MAX_ITEMS).map((r): ArtItem => {
         const full = str(r.image);
         return {
           id: `prado-${str(r.id)}`,
           title: str(r.title) || 'Untitled',
           artist: str(r.author),
           dimensions: '',
           thumbUrl: str(r.thumbnail) || full,
           previewUrl: full,
           fullUrl: full,
           format: fmtFromUrl(full),
           lossless: false,
           downloads: [],
           source: 'prado',
           isPublicDomain: r.rights === 'public-domain',
           date: str(r.date) || undefined,
           medium: str(r.technique) || undefined,
           sourceUrl: str(r.url) || undefined,
         };
       });
     } finally {
       clearTimeout(t);
     }
   }
   ```
   Helpers available in `art.ts`: `timedFetch(url, signal)`, `TIMEOUT_MS`,
   `MAX_ITEMS`, `str(v)`, `fmtFromUrl(url)`, `fmtFromMime(mime)`.

2. **Add the key to the shared `SourceKey` union** in
   `packages/core/src/art-source.ts` (one word, the adapter `key`).

3. **Register it** in `SOURCES`:
   ```ts
   { key: 'prado', label: 'Prado', fetch: fetchPrado },
   // keyed?            add  requiresEnv: 'PRADO_API_KEY'
   // any of several?   add  requiresAnyEnv: ['HARPE_PRADO_DUMP_DATASET', 'HARPE_DUMP_DATASET']
   // not ready yet?    add  disabled: true, note: '…'
   ```
   `requiresEnv` gates a source on ONE env var; `requiresAnyEnv` enables it when
   ANY of several are set (used by the dump-backed museums — see below). A source
   with neither is always-on (keyless).

3b. **Add UI metadata** in `src/lib/source-meta.ts`: a `SOURCE_LABELS` entry (the
   badge/chip label) and a `SOURCE_ORDER` entry (chip sort position). Both maps are
   typed `Record<DisplaySource, …>`, so a missing entry is a **typecheck error**
   (and `source-meta.test.ts` re-asserts it) — you can't ship an unlabeled source.

### Dump-backed sources (no live search API)

MoMA, NGA and MIA have no usable live search API, so they're harvested offline
into a normalized Parquet on Hugging Face and queried via HF's keyless `/search`.
They're still first-class `SOURCES` entries; they just share one cached HF call
per query (`fetchDumpSearch`, keyed by `(dataset, query)`) and split rows by the
normalized `source` field. To add one: ingest it in
`scripts/ingest-art-dumps/ingest.py`, add it to `DUMP_SOURCE_LABELS`, and register
it with `fetch: (q) => fetchDumpSource('<key>', q)` plus
`requiresAnyEnv: [dumpDatasetEnv('<key>'), 'HARPE_DUMP_DATASET']`.

4. **Verify it live from the repo root** — it returns results and they're all
   unified-valid:
   ```sh
   LIVE_QUERY="velazquez" pnpm run test:live      # runs every active source
   ```
   The deterministic suite (`art-sources.test.ts`) already guards the registry
   (unique keys, env-gating); the live suite (`sources.live.test.ts`) now covers
   your source with no extra wiring.

5. If the source needs a free key, document it in `SETUP.md` and gate it with
   `requiresEnv`.

## Tips

- **Public domain**: map the API's rights/license field; default `false` if unsure.
- **Images**: prefer the largest URL for `fullUrl`; a smaller one for `thumbUrl`.
  IIIF? build `…/full/!1200,/0/default.jpg` for `previewUrl`.
- **Resilience**: always use `timedFetch` (per-source timeout) so a slow source
  can't stall the search — a failure just becomes a per-source warning.
- **Hotlink blocks**: the `UA` constant is a browser UA; the client proxies
  http→https via `/api/fetch` for mixed-content/CORS.

> Tip: the `add-art-source` skill scaffolds steps 1–4 for you.
