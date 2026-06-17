# Adding a museum / gallery source

Every art source is one **adapter** in the `SOURCES` registry. Add one entry and
search, ranking, streaming, the unified-shape validator and the live test pick it
up automatically. There is exactly one place to add a gallery.

## The unified item (`ArtItem`)

Your adapter's job: turn the source's API response into `ArtItem[]`. The shape
(defined in `src/lib/server/handlers/art.ts`):

| Field | Req | Notes |
|---|---|---|
| `id` | ✅ | globally unique — prefix with your key, e.g. `` `prado-${objId}` `` |
| `title` | ✅ | artwork title (fallback to a sensible default, never empty) |
| `source` | ✅ | your adapter `key` (must be added to the `ArtItem['source']` union) |
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

2. **Add the key to the `ArtItem['source']` union** (one word, the `key`).

3. **Register it** in `SOURCES`:
   ```ts
   { key: 'prado', label: 'Prado', fetch: fetchPrado },
   // keyed?  add  requiresEnv: 'PRADO_API_KEY'
   // not ready yet?  add  disabled: true, note: '…'
   ```

4. **Verify it live** — it returns results and they're all unified-valid:
   ```sh
   LIVE_QUERY="velazquez" npm run test:live      # runs every active source
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
