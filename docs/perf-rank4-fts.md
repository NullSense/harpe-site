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

## What the numbers say

- **Latency is a non-issue.** Sub-ms on 63k; FTS5 stays ms-range into the millions, and
  range reads keep that true regardless of file size.
- **Size is the only variable.** At ~378 B/row the file scales linearly: 1M rows ≈ 0.4 GB,
  10M ≈ 4 GB. That's fine for *range-read* querying (only KB fetched per query) but affects
  build/upload time and the page-size tuning. **Open question: the full dump's row count**
  (the local file is NGA-only; the full HF `train.parquet` has 13 sources).
- The full schema also has `depicts_labels` / `depicts_qids` / `artist_qid` (absent from the
  local subset) — index `depicts_labels` into the FTS too; keep `depicts_qids` as an
  auxiliary column for the subject-page exact-match.

## Implementation plan (one focused pass)

1. **Build step** — add `build_fts()` to `scripts/ingest-art-dumps/enrich_entities.py` (it
   already has DuckDB + the parquet): read the full `train.parquet`, build the FTS5 SQLite
   (FTS over `title, artist, depicts_labels`; auxiliary `source, depicts_qids` + display
   cols), `optimize` + `VACUUM`, tune `page_size` (4–8 KB) for range efficiency, upload to
   HF as `data/art.sqlite`. Gate behind a flag so it ships via `--enrich-only --push`.
   **Measure the real file size here — it decides shard-vs-single-file.**
2. **Query adapter** — a `fetchFtsSearch(q)` matching the existing
   `fetchDumpSearch(dataset, q) → ArtItem[]` contract, querying the remote `.sqlite` over
   HTTP range. Decision:
   - **Function-side (recommended first):** drop-in replacement for `fetchDumpSearch`,
     keeps the API shape; the Vercel function does the range reads. Needs a Node SQLite
     HTTP-range VFS (`sql.js` with a custom range VFS, or a port of `sql.js-httpvfs`). If
     the file is small enough (< ~50 MB), whole-file fetch + in-memory `sql.js` cached per
     warm instance is the simplest viable v1.
   - **Browser-side (later):** true zero-backend, infinite scale via `sql.js-httpvfs`
     straight from the client; changes `Finder.tsx` to query the index directly.
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
