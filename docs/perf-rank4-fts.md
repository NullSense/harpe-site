# Rank 4 — static FTS5 search index (the durable cold-latency fix)

> Status: **prototyped & proven viable**, not yet implemented. Blocked here on the full
> HF dataset (to size the index) + HF write creds (to publish). This note captures the
> measurements and the exact plan so it can be executed in one focused pass.

## Why

After the Rank 1–3 work, every search stage is time-bounded and nothing rides to the 60s
function limit. The **one residual cold-latency wall** is the shared Hugging Face
`datasets-server/filter` call: when its per-dataset DuckDB index is cold AND the result
isn't in Upstash KV / the CDN, a *novel* query pays the full cold-index build (measured
22–25s live). The keep-warm cron hides this for popular queries; novel queries still pay.

Constraint from the owner: **no backend, serverless, free, scales to thousands.**

## The approach

Replace the HF `/filter` call with a **prebuilt SQLite FTS5 index queried over HTTP range
reads** (the `sql.js-httpvfs` pattern), the `.sqlite` file hosted as a **static asset on
the HF dataset CDN** we already use (`…/resolve/main/`). It's a static file → no backend,
no DB to provision; range requests pull only the B-tree/posting pages a query needs (tens
of KB) → free + CDN-scaled; there is **no per-dataset "index build" latency** like HF
datasets-server, so cold ≈ one CDN round-trip.

Host on **HF**, not Vercel Blob — Blob Hobby caps transfer at 10 GB/mo (flagged in review);
HF CDN has no such cap and is already in use.

## Prototype measurements (real, local)

Built an external-content FTS5 index over the **local 63,238-row NGA subset**
(`harpe-art.parquet`):

| Metric | Value |
|---|---|
| Rows | 63,238 |
| Index file (FTS5 + content table) | **23.9 MB** (~378 B/row) |
| Query latency (`MATCH` + join, LIMIT 100) | **0.07–0.29 ms** |

Reproduce:

```python
# uv run --with duckdb python build_fts_proto.py
import duckdb, sqlite3, os, time, tempfile
src = "harpe-art.parquet"
db = os.path.join(tempfile.gettempdir(), "fts_proto.sqlite")
if os.path.exists(db): os.remove(db)
rows = duckdb.connect().execute(f"""
  SELECT id, source, title, artist, image_thumb, image_full, source_url, wikidata_qid
  FROM '{src}'""").fetchall()
s = sqlite3.connect(db)
s.execute("PRAGMA journal_mode=OFF"); s.execute("PRAGMA synchronous=OFF")
s.execute("CREATE TABLE art(id TEXT, source TEXT, title TEXT, artist TEXT, image_thumb TEXT, image_full TEXT, source_url TEXT, wikidata_qid TEXT)")
s.executemany("INSERT INTO art VALUES (?,?,?,?,?,?,?,?)", rows)
s.execute("CREATE VIRTUAL TABLE art_fts USING fts5(title, artist, content='art', content_rowid='rowid')")
s.execute("INSERT INTO art_fts(rowid,title,artist) SELECT rowid,title,artist FROM art")
s.execute("INSERT INTO art_fts(art_fts) VALUES('optimize')"); s.commit()
s.execute("VACUUM"); s.commit()
# query: WHERE art_fts MATCH '<term>*' ORDER BY rank LIMIT 100, join art on rowid
```

## Full dataset size (from HF datasets-server)

`NullSense/harpe-art`: **2,145,751 rows · 174 MB parquet** (13 sources). The local
`harpe-art.parquet` is just the 63k-row NGA slice.

## What the numbers say

- **Latency is a non-issue.** Sub-ms on 63k; FTS5 stays ms-range into the millions, and
  range reads keep that true regardless of file size.
- **Size: the full index ≈ 0.8–1.1 GB.** 2.15M rows × ~378 B/row ≈ 0.8 GB, plus ~20–40%
  once `depicts_labels` is indexed → ~1 GB. Range-read querying is unaffected (only KB
  fetched per query), but **this rules out the "whole-file load into a Vercel function"
  v1** — a ~1 GB download per cold instance is a non-starter. So the query side must be one
  of:
  - **Browser-side `sql.js-httpvfs`** (recommended) — pure HTTP range reads from the HF
    CDN, never loads the whole file; true zero-backend, infinite scale. Changes
    `Finder.tsx` to query the index directly.
  - **Per-source sharding** (~13 files) — each small enough for function-side whole-file
    load; keeps the API shape but adds a fan-out + per-shard cache.
  - **Slim content table** — store only `id` + searchable text in the index, fetch display
    fields via the existing `/api/item`; shrinks the file but adds a second round-trip.
- The full schema also has `depicts_labels` / `depicts_qids` / `artist_qid` (absent from the
  local subset) — index `depicts_labels` into the FTS too; keep `depicts_qids` as an
  auxiliary column for the subject-page exact-match.

## Implementation plan

1. **Build step — DONE** (`enrich_entities.build_fts`, called from `enrich()`, opt-out via
   `--no-search-index`; tested in `test_enrich_entities.py`). Reads the enriched parquet,
   builds an external-content FTS5 SQLite (FTS over `title, artist, depicts_labels`;
   `source, depicts_qids` + display cols stored alongside), `optimize` + `VACUUM`,
   `page_size=4096` (match the client `requestChunkSize`), uploads to HF as `data/art.sqlite`.
   Ships with `--enrich-only --push`. **Verified on the real local 63k subset: 27.4 MB,
   0.3 s → extrapolates to ~930 MB / ~10 s at the full 2.15M rows.** (~1 GB confirms the
   browser-side range-read query path below; whole-file function load is out.)
2. **Query adapter** — query the remote `.sqlite` over HTTP range. At ~1 GB (see sizing
   above) whole-file load is out, so:
   - **Browser-side `sql.js-httpvfs` (recommended):** the client queries the HF-hosted
     index directly via range reads — zero backend, infinite scale. Changes `Finder.tsx`
     (and the result shape mapping) to call the index instead of `/api/art` for the dump
     tier. Best fit for a ~1 GB file.
   - **Per-source sharding (if you want to keep the API shape):** a `fetchFtsSearch(q)`
     matching `fetchDumpSearch(dataset, q) → ArtItem[]`, fanning out over ~13 small
     per-source shards that ARE small enough for function-side whole-file load (cached per
     warm instance).
3. **Wire-in** — register the FTS path as the dump source behind a feature flag
   (`HARPE_FTS_INDEX`), A/B against the HF `/filter` path, then flip.
4. **Verify** — local fixture tests for the build step + the adapter; live A/B on cold
   latency (target < 5s cold, < 100 ms warm).

## Deploy (owner-run; needs HF creds via infisical)

```
# builds + uploads data/art.sqlite alongside the existing entity files
infisical run --env dev --path /Harpe -- uv run scripts/ingest-art-dumps/ingest.py --enrich-only --push
```
Then set `HARPE_FTS_INDEX` in Vercel and redeploy to flip the dump source over.
