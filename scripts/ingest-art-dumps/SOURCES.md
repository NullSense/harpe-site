# Harpe data sources — dump-backed ingest status

Harpe searches two ways:

1. **Dump-backed index** (deep, exhaustive, fast) — a source's full open-data dump
   is ingested once by `ingest.py` into one Parquet on Hugging Face, which the site
   queries via HF's keyless `/search` API. This is what makes a whole art *movement*
   return thousands of works instead of a ~25-row live-API sample.
2. **Live API metasearch** (fresh, broad, but only *samples* per query) — the
   fallback for sources we haven't ingested.

We store **metadata + image URLs only** — never image bytes (those stay on the
museums' servers and are hotlinked on demand). So each source adds only tens of MB.

This file tracks which sources are ingested, and documents the ones deferred —
with the exact recipe or blocker — so the research behind each decision is kept.

---

## ✅ Implemented (in `ingest.py`, registered in `SOURCES`)

Verified row counts are from live validation runs (see git history / agent reports).

| Key | Source | ~Rows w/ image | Dump mechanism | License |
|---|---|---|---|---|
| `moma` | Museum of Modern Art | ~90k | GitHub JSON (LFS) | CC0 meta, img rights-reserved |
| `nga` | National Gallery of Art | ~50k | GitHub CSV | CC0 (open access) |
| `mia` | Minneapolis Institute of Art | ~80k | GitHub sharded JSON (shallow clone) | CC0 |
| `wellcome` | Wellcome Collection | **126,523** (74k PD) | single daily `images.json.gz` (32 MB) | per-item (pdm/cc0/cc-by) |
| `aic` | Art Institute of Chicago | **119,903** (57k PD) | `artic-api-data.tar.bz2` (115 MB) → per-file JSON | CC0 meta, per-work PD flag |
| `cleveland` | Cleveland Museum of Art | **68,750** | single `data.json` (117 MB, LFS) | CC0 (meta + PD images) |
| `smk` | National Gallery of Denmark | ~54,398 | keyless REST harvest → JSONL (~28 pages) | CC0 meta, PD mark |
| `met` | The Metropolitan Museum of Art | ~260k PD | **official HF dataset** `metmuseum/openaccess` parquet (image URLs baked in) | CC0 |
| `si` | Smithsonian Open Access | ~86k (8 art units) | S3 art-unit files (`00..ff.txt`, ~350 MB) | CC0 |
| `wikidata` | Wikidata (paintings/sculpture/print/drawing) | ~680k | WDQS SPARQL paging → JSONL, adaptive + resumable | CC0 meta, per-item img |
| `loc` | Library of Congress (Prints & Photographs) | ~tens of k (capped; ~1M full) | keyless JSON API, year-window paged → JSONL; IIIF images | mostly PD / no known restrictions |
| `harvard` | Harvard Art Museums | ~200k (full) | **key-gated** REST API → full-res IIIF; `HARVARD_API_KEY` | ⚠ **non-commercial ToS** — opt-in |
| `europeana` | Europeana (aggregator) | up to ~21M (capped 500k default) | **key-gated** cursor Search API; provider full-res (~90%) + Europeana thumb fallback | per-item; `reusability=open` |

**Combined deep-searchable total: ~1.6M+ works** (CC0 core) — up to several M more if the
key-gated `harvard`/`europeana` are ingested. Run those explicitly (`--sources harvard` /
`--sources europeana`) with their env keys set; they skip cleanly when no key is present.

> **`met` is now dump-backed (no crawl).** The Met *API* (collectionapi) is behind an
> Imperva/Incapsula wall, but its *image CDN* (images.metmuseum.org) is open, and the
> Met publishes its own Hugging Face open-access dataset with image URLs baked in. We
> read that parquet directly — ~260k PD works, zero crawling, no key. (The old greedy
> API crawl was removed.)

### Run — one command
```bash
huggingface-cli login                                          # once
uv run scripts/ingest-art-dumps/ingest.py --push NullSense/harpe-art
```
Builds **every** source in parallel and publishes. Backfill a single source the same way
(it **adds**, never replaces): `… ingest.py --sources met --push NullSense/harpe-art`.
Harvest artifacts cache in `$TMPDIR` (`harpe-met.jsonl`, `harpe-wikidata.jsonl`,
`harpe-si-art/`, `harpe-aic-data/`) — delete one to force a re-pull. Other flags:
`--sources a,b` (subset), `--jobs N` (cap parallelism), `--out FILE` (local only).

### Speed: everything pulls in parallel
All sources are harvested **concurrently** — one thread + its own DuckDB connection
each, writing a per-source parquet, combined locally at the end. Total wall-time ≈ the
single slowest source (Met), not the sum. Cap with `--jobs N` if you want to be gentler
on bandwidth; default pulls every source at once. Within a source, work is also
concurrent (SI: 24 download threads; Met: 16 request workers; DuckDB scans parallelized).

### Failure tolerance (the script won't sink on one bad source)
Every source is **isolated** in its own thread/connection/parquet, so a failure in
either the prep step (download/harvest) *or* at query time (a dead `read_json`/`read_csv`
URL) skips just that source — the rest still build and the Parquet is written. Other guards:
- **Retry + backoff + jitter** on every network fetch via **`tenacity`**; a persistent
  401/403/429/503 → `HarvestBlocked` (caller skips that source).
- **Adaptive page sizing for Wikidata** (AIMD): the WDQS page grows on success and halves
  the instant a response truncates (the 60s-timeout failure mode), re-fetching the *same*
  offset smaller so no rows are lost — self-tunes to the endpoint's current capacity.
- **Circuit breakers**: Met preflights the API and aborts on a run of consecutive 403s;
  Smithsonian tolerates 404 (empty buckets) but aborts if >20% of files fail.
- **Atomic writes everywhere**: harvests write to `.tmp`/`.partial` and rename on success,
  so an interrupted run never caches a truncated dump or overwrites a good Parquet.
- **Merge-on-publish**: publishing downloads the live dataset and keeps any source you
  didn't (or couldn't) build this run — **no run can shrink the published dataset**.
- **Progress bars** (tqdm) on the long harvests: Met (per-object), Smithsonian (per-file),
  Wikidata (per-artwork) — live %, rate, ETA, and image/blocked counts.
- **Resumable Met & Wikidata**: both stream rows to a `.partial` (Wikidata also keeps a
  per-class offset `.state.json`), so **Ctrl-C / a crash / a hard refusal keeps progress** —
  re-running `--sources met` / `--sources wikidata` skips what's done and continues. The
  partial is renamed to the final cache only on full completion. (Other harvests cache their
  whole result on success.)

### Site registry — DONE (flipped 2026-06-18)
`packages/sources/src/registry.ts` now serves `moma, nga, mia, aic, cleveland, wellcome,
smk, si, wikidata, met, loc, harvard, europeana` (13) from the dump (`fetchDumpSource`, gated
on `HARPE_DUMP_DATASET`), so the site searches the deep index instead of sampling those live
APIs. Remaining live-API: commons, wikiart, vam, nasjonalmuseet, digitalnz, **parismusees**
(query rebuilt against the current NodeOeuvre schema — thumbnails only on a public token;
HD is private-API). To dump-back a new source later: add it to `DUMP_SOURCE_LABELS` in
`adapters.ts`, then add a `dump('<key>', '<Label>')` line in `registry.ts`.

> **Full-res with your keys (2026-06-18):** Harvard serves full-res IIIF (validated 200
> image/jpeg) and Europeana's `edmIsShownBy` provider images load ~90% of the time (thumb
> fallback for the rest) — so both are real full-res sources, not thumbnail-only. Paris
> Musées HD is genuinely gated to a *private* API; a public token returns thumbnails only.

### Site runtime resilience — `resilience.ts` (cockatiel)
The per-request fan-out is wrapped in resilience policies so one degraded upstream can't
tax every search (latency-bound hot path — retries are deliberately NOT added to live
adapters, only fail-fast + breaker):
- **Per-source circuit breaker + cooperative timeout** — `gatherSources` runs each live
  source through `sourcePolicy(key)` = `wrap(breaker, timeout)`. After 4 consecutive
  failures the source's circuit opens and returns `[]` instantly for an exponential
  cooldown (10s→60s) instead of paying the 12s upstream timeout every query. The timeout
  supplies the `AbortSignal` adapters fetch with — one knob, via the `deadline()` helper —
  replacing 17 hand-rolled `AbortController` blocks.
- **Shared HF `/search` policy** — the 9 dump sources share one `fetchDumpSearchUncached`
  call wrapped in `dumpHttpPolicy` = `wrap(breaker, retry, timeout)`: a fast retry absorbs
  transient HF blips (so one hiccup doesn't blank all 9 sources), the breaker fails fast on
  a sustained HF outage. Dump sources set `dumpBacked: true` so they skip the per-source
  live policy (one endpoint, one breaker). `fetchDumpSource` degrades to `[]` when open.
- Breaker state is per warm serverless instance (module-level), the documented cockatiel
  serverless model — a latency optimizer, not a global mechanism.

### Hugging Face transfer
Uploads/downloads in `ingest.py` ride **hf_xet** (the Hub's default chunk-deduped accelerated
transport; the old `hf_transfer` / `HF_HUB_ENABLE_HF_TRANSFER` is deprecated and ignored).
`publish()` sets `HF_XET_HIGH_PERFORMANCE=1` and the dep is `huggingface_hub[hf_xet]`.

---

## ⏸️ Deferred — feasible, but key-gated or low-ROI

### Europeana — `europeana`  (IMPLEMENTED, key-gated opt-in)
Now a real source (see implemented table): provider full-res via `edmIsShownBy` (~90% load,
HEAD-verified) with Europeana's hosted thumbnail as fallback. Needs `EUROPEANA_API_KEY`;
default-capped at 500k rows; run explicitly. Caveat: re-aggregates Rijksmuseum/Wellcome/SMK
etc. we already carry, so expect some duplication.

### Harvard Art Museums — `harvard`  (IMPLEMENTED, key-gated, ⚠ non-commercial ToS)
Now a real source: full-res IIIF (`baseimageurl` → `/full/full/0/default.jpg`, validated 200).
Needs `HARVARD_API_KEY`. ⚠ Harvard's API ToS is **non-commercial + attribution** — only
ingest if your use qualifies; that's an operator decision. Rate limit 2,500/day.

### Nasjonalmuseet (Norway) — `nasjonalmuseet`  (needs a free KulturIT/DiMu key)
- v1 Collection API retired Jan 2025; v2 not shipped. Harvest via **DiMu Solr**:
  `https://api.dimu.org/api/solr/select?q=*&fq=identifier.owner:NMK*&wt=json&api.key=<key>`
  (100 rows/req), then `https://api.dimu.org/artifact/uuid/<uuid>` for detail.
- **Images:** `https://dms01.dimu.org/image/<id>?dimension=max` (not IIIF).
- **Rights:** metadata CC0, photos CC-BY 4.0; `artifact.ingress.license` per work. Filter
  `NMK-B` for fine art. ~36–60k objects.

---

## ❌ Not pursued — legal / practical blockers (Tier C/D)

### V&A — `vam`  (harvestable, but ToS)
- Full harvest is practical (~732k image objects, ~2h via `api.vam.ac.uk/v2/objects/search?images_exist=1`).
- **Blocker:** ToS is **non-commercial** and **hotlink-only / no image caching**. We never
  cache image *bytes* (we hotlink IIIF), so the no-cache rule is satisfiable — but the
  **non-commercial** clause is a deliberate decision for a public site. Keep live-only
  unless that's cleared. (IIIF base + `systemNumber` are in every record.)

(Harvard and Paris Musées moved out of this section — Harvard is now an opt-in key-gated
dump source, and Paris Musées is fixed + live again; see above.)

### DigitalNZ — `digitalnz`  (needs key)
- Aggregator; **no dump** (promised in 2014, never shipped). Per-contributor rights, no IIIF,
  `large_thumbnail_url` hotlinking contractually restricted, heavy link rot. Keep live-only.

### Wikimedia Commons (SDC) — `commons`
- SDC `mediainfo` dump exists (~70 GB compressed, all 100M+ files) but **no artwork-only
  sub-dump**. Cleanest scope is to **join against our Wikidata QID set via `P6243`**
  (~225k files) — i.e. a follow-on to the `wikidata` ingest, not a standalone source.
  Until then, keep Commons live-only. (No bulk image-binary dumps since ~2013.)

### WikiArt — *excluded entirely*
- **No official dump or open API.** Its ToS forbids reproduction/republishing; the
  unofficial Kaggle/HuggingFace scrapes are **non-commercial research only** and
  incomplete (63k–178k of ~250k). Building a public index on it is a ToS/copyright
  liability. **Do not ingest.** Lean on primary-source museum dumps instead (which the
  Tier A/B additions above now do at scale).

---

## Adding a new source
1. Write a function/constant that emits the **union schema** columns
   (`source, id, title, artist, date, medium, dimensions, culture, credit_line,
   description, image_thumb, image_full, width, height, source_url, rights_type,
   is_public_domain`). Missing columns are fine — the build uses `UNION ALL BY NAME`.
2. Register it in the `SOURCES` dict in `ingest.py`.
3. `id` must be globally unique → prefix with the source key.
4. Metadata + hotlink image URLs only; set `is_public_domain` only when the source
   itself asserts PD/CC0.
