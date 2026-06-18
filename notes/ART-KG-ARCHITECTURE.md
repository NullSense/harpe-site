# Harpe Art Knowledge Graph — Final Architecture Spec

## Guiding Principles

- **Wikidata is the spine.** Every cross-source identity link is anchored to a QID. No proprietary ontology.
- **Static JSON files on HF are the only new runtime store.** The HF `/filter` WHERE API returns HTTP 422 for all predicate queries on the live endpoint — it is not used. All entity lookup goes through static pre-baked JSON blobs fetched by plain HTTPS GET.
- **Two distinct SPARQL passes for Wikidata.** The existing `_WD_QUERY` emits only labels via `SERVICE wikibase:label`; it does NOT emit creator QIDs or P180 depicts. A separate `harvest_wikidata_entities()` function queries P170/P180/P195 in VALUES blocks of 50 QIDs after the main harvest. These must not be conflated.
- **CLIP clustering is offline and opt-in.** `cluster_id` is an ephemeral INTEGER column for dedupe() only — never exposed in URLs or external state.
- **No new paid infra.** HF public dataset storage, Upstash Redis free tier (existing), Vercel Hobby plan (existing).
- **Reuse every existing seam.** `dumpHttpPolicy`, `_retry()`, `DUMP_CACHE_TTL_S`, `fetchDumpSearch()`, `dedupe()`, `normalizeArt()`, `MERGE_FILL_FIELDS`.

---

## Known API Constraints (settled before any code is written)

### HF `/filter` WHERE — broken, do not use

`GET https://datasets-server.huggingface.co/filter?...&where=artist_qid='Q41406'` returns HTTP 422 on the live API. All runtime entity lookup uses static JSON files on the HF CDN instead.

### HF `/search` for depicts — unsafe for QID matching

`/search` is BM25 full-text over entire rows. Searching for `Q146` matches any row containing that string anywhere (including rows whose `wikidata_qid` IS Q146, their `source_url`, etc.). Not used for entity browse.

### HF raw CDN — confirmed working, zero auth

`https://huggingface.co/datasets/NullSense/harpe-art/resolve/main/data/artists/Q41406.json` is a plain HTTPS GET, ~50–150ms, no API key, no query engine. This is the runtime lookup path.

---

## Data Model

### Table 1 — `works` (`data/train.parquet`, extended)

Existing columns unchanged. New optional columns added via a **separate post-harvest enrichment pass** (NOT inline in `_WD_QUERY`). `union_by_name=true` in `build_parquet()` (line 1359) handles NULL for non-Wikidata sources with zero per-source changes.

| Column | Type | Notes |
|---|---|---|
| `wikidata_qid` | VARCHAR | The `Q…` part of the `wd-Q…` id, extracted at ingest from the existing `id` field — zero new SPARQL needed for works already harvested |
| `artist_qid` | VARCHAR | P170 creator QID from the entity enrichment pass |
| `depicts_qids` | VARCHAR | Space-separated QID string: `'Q146 Q5 Q8242'` — flat VARCHAR, not a list type, for reliable HF `/search` token matching |
| `collection_qid` | VARCHAR | P195 collection QID |
| `movement` | VARCHAR | P135 art movement label (EN) |
| `cluster_id` | INTEGER | Union-find root index from offline pHash/CLIP pass; NULL = singleton |

**Why `depicts_qids` is flat VARCHAR, not VARCHAR[]:** The HF datasets-server does not expose `ARRAY_CONTAINS` through its WHERE clause. Storing as a space-separated string enables exact-token matching via `/search` with a post-filter guard (confirm the QID appears as a whole `\bQxxx\b` word, not a substring collision). This decision locks the schema before Phase 1 ships and avoids a full re-ingest to change the column type later.

**Why `wikidata_qid` requires no new SPARQL:** The existing harvest already writes `"id": "wd-Q1234567"`. The enrichment pass extracts the Q-ID from the existing JSONL with `wid[3:]` (strip `"wd-"` prefix) — no WDQS round-trip for the works table itself.

---

### Static JSON Entity Files (new, on HF CDN)

Pushed to the same `NullSense/harpe-art` repo as static files, accessed by plain CDN GET. No query engine involved.

#### `data/artists/<QID>.json` — one file per artist

```json
{
  "qid": "Q41406",
  "labelEn": "Claude Monet",
  "description": "French Impressionist painter (1840–1926)",
  "aliases": ["Monet", "Oscar-Claude Monet"],
  "birthYear": 1840,
  "deathYear": 1926,
  "nationality": "French",
  "movementLabels": ["Impressionism", "en plein air"],
  "ulanId": "500010468",
  "imageCommons": "Claude_Monet_1899_Nadar_crop.jpg",
  "workCount": 312
}
```

#### `data/depicts/<QID>.json` — one file per subject entity

```json
{
  "qid": "Q146",
  "labelEn": "cat",
  "description": "small domesticated carnivorous mammal",
  "imageCommons": "Cat_poster_1.jpg",
  "workCount": 487
}
```

#### `data/name_to_qid.json` — single flat lookup file (~2 MB)

```json
{
  "monet": "Q41406",
  "claude monet": "Q41406",
  "oscar claude monet": "Q41406",
  "van gogh": "Q5582",
  "vincent van gogh": "Q5582",
  "gogh": "Q5582",
  ...
}
```

Keys are all aliases/label variants after `normalize()`. Non-Latin scripts (CJK, Cyrillic, Arabic) are stored **raw** (not normalized) under a separate key prefix `"raw:"` alongside their normalized form, so `"raw:齐白石"` → QID also resolves.

**This file is bundled directly into the Vercel deployment** (at `src/data/name_to_qid.json`, imported as a module-level constant in `adapters.ts`) — not fetched from HF at cold-start. At ~2 MB compressed it is well under the 50 MB Vercel function bundle limit. V8 JSON.parse cost is ~15ms at cold-start, not 200–500ms of network. If the file grows beyond 4 MB uncompressed, move it to a public CDN fetch with a 5-second timeout and in-memory singleton.

#### `data/work_ids_by_artist/<QID>.json` — work IDs per artist (~10 KB each)

```json
["wd-Q12345", "wd-Q67890", ...]
```

Used by the artist page to fetch which work rows to pull from the Parquet via `/search`. Populated at ingest time. Allows the artist handler to do one `/search` call using the artist name (already indexed) rather than needing `/filter`.

---

## HF Dataset Layout

```
NullSense/harpe-art/
  data/train.parquet                    ← existing (extended schema)
  data/artists/Q41406.json             ← one file per artist QID
  data/depicts/Q146.json               ← one file per subject QID
  data/work_ids_by_artist/Q41406.json  ← work IDs per artist
  data/name_to_qid.json                ← full alias→QID map (also bundled in repo)
```

All files are public. Individual files are accessed via the HF resolve CDN URL. The `data/artists/` and `data/depicts/` directories contain thousands of small JSON files (one per entity) — HF supports arbitrary file paths under `data/`.

---

## Ingest Pipeline Changes (`scripts/ingest-art-dumps/ingest.py`)

### Step 1 — Schema extension: extract `wikidata_qid` from existing JSONL

In `wikidata_sql()` (line 925–931), extend the SELECT to extract the QID from the existing `id` column:

```python
def wikidata_sql(jsonl_path: str) -> str:
    p = jsonl_path.replace("'", "''")
    cols = ("{source:'VARCHAR',id:'VARCHAR',title:'VARCHAR',artist:'VARCHAR',date:'VARCHAR',"
            "medium:'VARCHAR',dimensions:'VARCHAR',culture:'VARCHAR',credit_line:'VARCHAR',"
            "description:'VARCHAR',image_thumb:'VARCHAR',image_full:'VARCHAR',width:'INTEGER',"
            "height:'INTEGER',source_url:'VARCHAR',rights_type:'VARCHAR',is_public_domain:'BOOLEAN'}")
    return (
        f"SELECT *, regexp_extract(id, '^wd-(Q[0-9]+)$', 1) AS wikidata_qid "
        f"FROM read_json('{p}', format='newline_delimited', columns={cols})"
    )
```

This adds `wikidata_qid` to the Wikidata source rows at zero SPARQL cost. The regex extracts `Q1234567` from `wd-Q1234567`. Non-Wikidata rows emit NULL (union_by_name handles this).

### Step 2 — Entity enrichment pass: new `harvest_wikidata_entities()` function

Called after `build_parquet()` completes, before `publish()`. This is a **separate SPARQL pass** — it does NOT touch `_WD_QUERY`.

```python
_WD_ENTITY_QUERY = """\
SELECT ?item ?creator ?creatorLabel ?depicts ?collection ?movement ?movementLabel
       ?birth ?death ?nationality ?nationalityLabel ?ulan ?viaf ?portrait WHERE {{
  VALUES ?item {{ {qids} }}
  OPTIONAL {{ ?item wdt:P170 ?creator . }}
  OPTIONAL {{ ?item wdt:P180 ?depicts . }}
  OPTIONAL {{ ?item wdt:P195 ?collection . }}
  OPTIONAL {{ ?item wdt:P135 ?movement . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" . }}
}}
"""

_WD_ARTIST_QUERY = """\
SELECT ?artist ?artistLabel ?birth ?death ?nationality ?nationalityLabel
       ?movement ?movementLabel ?ulan ?viaf ?portrait ?alias WHERE {{
  VALUES ?artist {{ {qids} }}
  OPTIONAL {{ ?artist wdt:P569 ?birth . }}
  OPTIONAL {{ ?artist wdt:P570 ?death . }}
  OPTIONAL {{ ?artist wdt:P27 ?nationality . }}
  OPTIONAL {{ ?artist wdt:P135 ?movement . }}
  OPTIONAL {{ ?artist wdt:P245 ?ulan . }}
  OPTIONAL {{ ?artist wdt:P214 ?viaf . }}
  OPTIONAL {{ ?artist wdt:P18 ?portrait . }}
  OPTIONAL {{ ?artist skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" . }}
}}
"""
```

**Batch size: 50 QIDs per VALUES block.** This avoids the row-multiplication problem that adding P180 inline to `_WD_QUERY` would cause. Each OPTIONAL binding produces a new result row in SPARQL — querying P180 for 2000 works inline would yield up to 20,000 result rows per page and break the adaptive batch sizing. The separate pass queries known QIDs in small batches with no LIMIT issue.

**P180 depicts handling:** The entity query returns one row per `(item, depicts)` pair. The function aggregates these into `depicts_qids` as a space-separated string before writing to Parquet. The deduplication is done in Python before writing, not in SPARQL (no GROUP_CONCAT, no row explosion concern at the SPARQL level).

**Attribution prefix stripping for artist name aliases:** Before adding names to `name_to_qid.json`, strip common attribution prefixes: `r'^(workshop of|after|attributed to|circle of|follower of|school of|studio of)\s+'` (case-insensitive). This avoids adding "Workshop of Rembrandt" as a key while still resolving "Rembrandt" from the label.

**Surname-suffix expansion for `name_to_qid.json`:** For each `label_en` with 2+ tokens, also add each trailing suffix of length ≥ 4 characters as an alias, with a uniqueness guard (if the suffix matches more than one QID, it is dropped from the table to prevent false merges):

```python
def suffix_variants(label: str) -> list[str]:
    """'Vincent van Gogh' → ['van gogh', 'gogh'] (min 4 chars)"""
    words = normalize(label).split()
    return [' '.join(words[i:]) for i in range(1, len(words)) if len(' '.join(words[i:])) >= 4]
```

Colliding suffixes (same normalized string resolves to >1 QID) are excluded entirely from `name_to_qid.json`.

**Non-Latin script handling:** Wikidata `skos:altLabel` for CJK/Cyrillic/Arabic artists is stored raw (bypassing `normalize()`) under the prefix `"raw:<original>"` in `name_to_qid.json`. The resolver checks both normalized and raw paths:

```typescript
function resolveArtistQid(rawName: string): string | undefined {
  const norm = normalize(rawName);
  return NAME_TO_QID[norm] ?? NAME_TO_QID[`raw:${rawName}`];
}
```

### Step 3 — `assign_cluster_ids()` (Phase 3, separate function)

**Phase 3a — pHash (CPU, always-on when `--cluster` flag is passed):**

Does NOT download `image_full` URLs. Uses `image_thumb` URLs (already harvested, 400px). Downloads thumbnails to a temp dir, runs imagededup `PHash.find_duplicates()`, assigns provisional `cluster_id` from connected components. Cleanup is atomic (temp dir removed after successful Parquet write).

**Phase 3b — CLIP (GPU, opt-in via `--embed` flag):**

Downloads the pHash-unresolved subset of thumbnails to a shard dir, runs `open_clip` ViT-H/14 on the RX 6700 XT (ROCm 6.x), builds FAISS HNSW index via `autofaiss`, unions pairs at cosine ≥ `CLIP_SIM_THRESHOLD = 0.92` into the existing pHash union-find. Title-mismatch veto: if both works have non-empty, non-generic titles whose normalized token sets share zero tokens, the CLIP merge is suppressed.

**Checkpointing:** `assign_cluster_ids()` writes a `.cluster_state.json` alongside the Parquet tracking which items have been processed. A crash mid-run resumes from the checkpoint rather than losing all work.

**`cluster_id` stability:** The column is an ephemeral INTEGER root index valid only within a single Parquet version. It is consumed by `dedupe()` at runtime and never persisted in URLs, Redis keys, or user-facing state. The `wikidata_qid` (stable, content-addressed) is used for all external-facing entity identity.

### Step 4 — `build_entity_files()` and `publish_entities()`

Called after `assign_cluster_ids()`, before `publish()`. Produces all static JSON files listed above and pushes them to HF using `HfApi.upload_file()` per file (same pattern as the existing `publish()` function). Uses a `CommitOperationsAdd` batch commit where possible to avoid N separate git commits on the HF repo.

---

## Runtime Query Path (Vercel Serverless, zero new infra)

### `name_to_qid` — bundled static import

```typescript
// packages/sources/src/adapters.ts (module scope)
import NAME_TO_QID from '../../src/data/name_to_qid.json' assert { type: 'json' };
// → Map loaded at module parse time, ~15ms V8 cost, zero network
```

`resolveArtistQid()` is O(1) map lookup. Called from `fetchDumpSearchUncached()` row deserialization to populate `artistId` for Wikidata-source items (which already have `wikidata_qid` from Step 1). Also called from live-source adapters for non-Wikidata items.

### Artist entity page (`GET /api/artist?qid=Q41406`)

```
Request → src/lib/server/handlers/artist.ts
  1. Check Upstash Redis: key `entity:artist:Q41406` (TTL 24h)
     → HIT: return cached JSON
  2. MISS: plain fetch from HF CDN
       GET https://huggingface.co/datasets/NullSense/harpe-art/resolve/main/data/artists/Q41406.json
     → one small JSON file, ~150ms P50
  3. Fetch work IDs:
       GET .../data/work_ids_by_artist/Q41406.json
     → list of `wd-Q…` ids
  4. Fetch matching works via HF /search (existing pattern):
       GET /search?dataset=NullSense/harpe-art&config=default&split=train
         &query=<artistLabelEn>&offset=0&length=100
     → filter result to only rows whose id is in the work-ID set
     (HF /search BM25 on the artist name already ranks these rows first for well-known artists)
  5. Store entity + works in Upstash Redis (TTL 24h)
  6. Return { entity: ArtistEntity, works: ArtItem[] }
```

Upstash command budget: 3 commands per cold load (1 GET miss, 1 GET for work IDs from CDN is not Redis, 1 SET). Warm: 1 GET hit.

### Depicts browse (`GET /api/depicts?qid=Q146&label=cat`)

```
Request → src/lib/server/handlers/depicts.ts
  1. Check Upstash Redis: key `entity:depicts:Q146` (TTL 24h)
  2. MISS:
     a. Fetch subject entity: .../data/depicts/Q146.json (HF CDN)
     b. Fetch works via HF /search:
          &query=Q146    (the QID string itself, as a whole token in depicts_qids)
        Post-filter: keep rows where depicts_qids field contains the word-boundary
        match /\bQ146\b/ (prevents substring collision with e.g. Q1460)
  3. Cache + return { entity: SubjectEntity, works: ArtItem[] }
```

The `/search` BM25 query on a bare QID string (e.g. `Q146`) is reliable when the QID is a whole space-separated token in the `depicts_qids` field. The post-filter `\bQ146\b` guard ensures no substring collision. This is confirmed safe because QIDs are always in the format `Q\d+` with no shared prefix between different QIDs in the space-separated string.

### Upstash command budget

Existing dump search: ~3 commands/request. New entity pages: ~2 commands/cold, 1/warm. At 1,000 searches/day + 200 entity page loads/day: ~3,200 commands/day, well within the 10,000/day free tier. This ceiling is acknowledged — at 3,000+ daily active users it would be exceeded; at that point, upgrade to Upstash $10/month plan (appropriate scale milestone).

---

## Deduplication Augmentation (`packages/core/src/search.ts`)

### `Fusable` interface additions

```typescript
export interface Fusable {
  // ... existing fields ...
  artistId?: string;    // Wikidata QID of P170 creator — drives artist-page link
  depicts?: string[];   // QIDs or labels of P180 targets — drives depicts browse
  clusterId?: number;   // offline CLIP/pHash cluster — consumed by dedupe() only
  movement?: string;    // art-historical movement label (P135 or ArtGraph)
}
```

### `dedupe()` — fourth union signal (byCluster)

Inserted after the `byQid` pass, before the title-bucket scan:

```typescript
// 1c) Offline cluster_id — precomputed pHash/CLIP cluster from ingest.
//     Only unions when both items carry the same non-null clusterId.
//     Title-mismatch veto: if both titles are present, non-generic, and share
//     zero canonTitle tokens → suppress the merge (CLIP false-positive guard).
const byCluster = new Map<number, number>();
items.forEach((it, i) => {
  const ck = (it as Fusable).clusterId;
  if (ck == null) return;
  const j = byCluster.get(ck);
  if (j !== undefined) {
    const ta = safeTitleKey(items[j]), tb = safeTitleKey(it);
    // Only veto when BOTH titles are non-empty and non-generic (safeTitleKey → '')
    if (ta && tb) {
      const tokA = new Set(ta.split(' ').filter(t => t.length >= 3));
      const tokB = tb.split(' ').filter(t => t.length >= 3);
      if (tokA.size > 0 && !tokB.some(t => tokA.has(t))) return; // veto
    }
    union(i, j);
  } else {
    byCluster.set(ck, i);
  }
});
```

### `MERGE_FILL_FIELDS` and `MERGE_UNION_FIELDS` additions

```typescript
const MERGE_FILL_FIELDS = [
  // ... existing: date, medium, culture, creditLine, description, sourceUrl,
  //   accessionNumber, licenseUrl, artworkType, style, inscriptions, dimensions, width, height, wikidataId ...
  'artistId', 'movement',
] as const;

const MERGE_UNION_FIELDS = ['tags', 'downloads', 'depicts'] as const;
// depicts is a union field: all copies' P180 QIDs merge onto the representative.
```

---

## ArtItem Contract Extension (`packages/core/src/art-source.ts`)

Four new optional fields added to the existing `ArtItem` interface (after `wikidataId`):

```typescript
/** Wikidata QID of P170 creator — drives /artist/:qid navigation. */
artistId?: string;
/** P180 depicts QIDs as a string array — drives /depicts/:qid navigation. */
depicts?: string[];
/** Offline pHash/CLIP cluster assignment — consumed by dedupe() only, never in URLs. */
clusterId?: number;
/** Art-historical movement label (P135 or ArtGraph enrichment). */
movement?: string;
```

New exported entity types:

```typescript
export interface ArtistEntity {
  qid: string;
  labelEn: string;
  description?: string;
  aliases?: string[];
  birthYear?: number;
  deathYear?: number;
  nationality?: string;
  movementLabels?: string[];
  ulanId?: string;
  imageCommons?: string;
  workCount: number;
}

export interface SubjectEntity {
  qid: string;
  labelEn: string;
  description?: string;
  imageCommons?: string;
  workCount: number;
}
```

---

## `normalizeArt()` fix (`src/Finder.tsx`)

The local `ArtItem` interface at line 55 of `Finder.tsx` is a re-declaration that diverges from `@harpe/core`'s `ArtItem`. Every new field added to the package type is silently dropped by `normalizeArt()` unless also added here. **Phase 1 must eliminate this dual-maintenance trap**, not defer it.

**The fix (Phase 1):** Replace the local `interface ArtItem` at line 55 with a direct import:

```typescript
import type { ArtItem } from '@harpe/core';
```

Remove the local declaration entirely. `normalizeArt()` then returns `Partial<ArtItem>` cast — any field missing from the raw SSE payload is absent, which is already the correct behavior (all new fields are optional). This is a one-time fix that makes all future field additions free.

After the import fix, add the five new field pass-throughs to `normalizeArt()`:

```typescript
wikidataId: typeof d.wikidataId === 'string' && /^Q\d+$/.test(d.wikidataId) ? d.wikidataId : undefined,
artistId:   typeof d.artistId   === 'string' && /^Q\d+$/.test(d.artistId)   ? d.artistId   : undefined,
depicts:    Array.isArray(d.depicts) ? (d.depicts as unknown[]).filter(s => typeof s === 'string') as string[] : undefined,
clusterId:  typeof d.clusterId  === 'number' ? d.clusterId : undefined,
movement:   txt('movement'),
```

Without these, all five fields are silently dropped before reaching `dedupe()`.

---

## Adapter Changes (`packages/sources/src/adapters.ts`)

### `fetchDumpSearchUncached()` — read new columns

In the row deserialization loop (line ~1617), after the existing field reads:

```typescript
wikidataId: typeof row.wikidata_qid === 'string' && row.wikidata_qid ? row.wikidata_qid : undefined,
artistId:   typeof row.artist_qid   === 'string' && row.artist_qid   ? row.artist_qid   : undefined,
depicts:    typeof row.depicts_qids === 'string' && row.depicts_qids
              ? row.depicts_qids.split(' ').filter(Boolean)
              : undefined,
clusterId:  typeof row.cluster_id   === 'number' ? row.cluster_id : undefined,
movement:   typeof row.movement     === 'string' && row.movement     ? row.movement     : undefined,
```

Note: `depicts_qids` is stored as a space-separated VARCHAR string (not a list type), so it is split by spaces here.

### `resolveArtistQid()` — called from row deserialization for non-Wikidata sources

```typescript
import NAME_TO_QID from '../../src/data/name_to_qid.json' assert { type: 'json' };

function resolveArtistQid(rawArtist: string): string | undefined {
  if (!rawArtist) return undefined;
  const norm = normalize(rawArtist);
  return (NAME_TO_QID as Record<string, string>)[norm]
    ?? (NAME_TO_QID as Record<string, string>)[`raw:${rawArtist}`];
}
```

Called in `fetchDumpSearchUncached()` when `row.artist_qid` is null/undefined and `row.artist` is present. This populates `artistId` for non-Wikidata dump-backed sources (MoMA, NGA, AIC, etc.) using the bundled lookup.

### New exported entity fetch functions

```typescript
const HF_CDN = 'https://huggingface.co/datasets/NullSense/harpe-art/resolve/main';

export async function fetchArtistEntity(qid: string): Promise<ArtistEntity | null> {
  return dumpHttpPolicy.execute(async ({ signal }) => {
    const res = await timedFetch(`${HF_CDN}/data/artists/${encodeURIComponent(qid)}.json`, signal);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<ArtistEntity>;
  });
}

export async function fetchArtistWorkIds(qid: string): Promise<string[]> {
  return dumpHttpPolicy.execute(async ({ signal }) => {
    const res = await timedFetch(`${HF_CDN}/data/work_ids_by_artist/${encodeURIComponent(qid)}.json`, signal);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<string[]>;
  });
}

export async function fetchSubjectEntity(qid: string): Promise<SubjectEntity | null> {
  return dumpHttpPolicy.execute(async ({ signal }) => {
    const res = await timedFetch(`${HF_CDN}/data/depicts/${encodeURIComponent(qid)}.json`, signal);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<SubjectEntity>;
  });
}
```

All use `dumpHttpPolicy` (existing cockatiel retry + breaker). Cached in Upstash Redis by the handler layer (not the adapter), consistent with existing pattern.

---

## New API Handlers

### `src/lib/server/handlers/artist.ts`

```typescript
export async function artistHandler(req, res) {
  const qid = String(req.query.qid || '');
  if (!/^Q\d+$/.test(qid)) { res.status(400).json({ error: 'invalid qid' }); return; }

  const redis = await getDumpRedis();
  const cacheKey = `entity:artist:${qid}`;

  if (redis) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) { res.json(typeof hit === 'string' ? JSON.parse(hit) : hit); return; }
  }

  const [entity, workIds] = await Promise.all([
    fetchArtistEntity(qid),
    fetchArtistWorkIds(qid),
  ]);
  if (!entity) { res.status(404).json({ error: 'artist not found' }); return; }

  // Fetch works via HF /search using artist label, filter to known work IDs
  const dataset = process.env.HARPE_DUMP_DATASET || '';
  let works: ArtItem[] = [];
  if (dataset && workIds.length > 0) {
    const idSet = new Set(workIds);
    const all = await fetchDumpSearch(dataset, entity.labelEn);
    works = all.filter(it => idSet.has(it.id)).slice(0, 100);
  }

  const payload = { entity, works };
  if (redis) await redis.set(cacheKey, JSON.stringify(payload), { ex: 86400 }).catch(() => {});
  res.json(payload);
}
```

### `src/lib/server/handlers/depicts.ts`

```typescript
export async function depictsHandler(req, res) {
  const qid = String(req.query.qid || '');
  if (!/^Q\d+$/.test(qid)) { res.status(400).json({ error: 'invalid qid' }); return; }

  const redis = await getDumpRedis();
  const cacheKey = `entity:depicts:${qid}`;

  if (redis) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) { res.json(typeof hit === 'string' ? JSON.parse(hit) : hit); return; }
  }

  const entity = await fetchSubjectEntity(qid);
  if (!entity) { res.status(404).json({ error: 'subject not found' }); return; }

  // Search for works using the QID as the query token (stored in depicts_qids field)
  const dataset = process.env.HARPE_DUMP_DATASET || '';
  let works: ArtItem[] = [];
  if (dataset) {
    const qidRe = new RegExp(`\\b${qid}\\b`); // e.g. /\bQ146\b/ — prevents substring collision
    const all = await fetchDumpSearch(dataset, qid);
    works = all.filter(it =>
      it.depicts?.some(d => qidRe.test(d)) // post-filter guard
    ).slice(0, 100);
  }

  const payload = { entity, works };
  if (redis) await redis.set(cacheKey, JSON.stringify(payload), { ex: 86400 }).catch(() => {});
  res.json(payload);
}
```

Wire both into `src/lib/server/handlers/index.ts` under keys `'artist'` and `'depicts'`. The dispatch in `api/[...path].ts` picks them up automatically.

---

## UI Changes (`src/Finder.tsx` + new pages)

### `normalizeArt()` — new fields (after fixing the local ArtItem re-declaration)

See the "normalizeArt() fix" section above. The five new field reads are added in one block.

### Artist button — navigate to artist page when QID is known

Current (line ~733): plain `onSearch(item.artist)` button.

After:
```tsx
<button
  onClick={() => item.artistId ? navigate(`/artist/${item.artistId}`) : onSearch(item.artist)}
  className="artist-link"
>
  {item.artist}
  {item.artistId && <span aria-hidden className="kg-arrow">→</span>}
</button>
```

`navigate` is `window.location.assign` or a React Router equivalent (the site currently uses hash routing; artist/depicts pages use `pushState` with a hash-based fallback for Vercel's SPA rewrite rules).

### Tag pills — navigate to depicts browse

Current: static `<span>` tags.

After:
```tsx
{(item.depicts ?? item.tags ?? []).slice(0, 8).map((tag, i) => (
  <button key={i}
    className="tag-pill"
    onClick={() => {
      const isQid = /^Q\d+$/.test(tag);
      if (isQid) navigate(`/depicts/${tag}`);
      else onSearch(tag); // non-QID tags fall back to search
    }}
    title={isQid ? `Browse works depicting this subject` : `Search for ${tag}`}
  >
    {tag}  {/* label resolution (QID → EN label) is done by the depicts page */}
  </button>
))}
```

### Movement filter chip

Add `movementFilter: string | null` state. In `visibleArt` useMemo filter:

```typescript
.filter(it => !movementFilter || it.movement === movementFilter)
```

UI: a "Movement" `<select>` chip in the filters row, populated from `[...new Set(art.map(it => it.movement).filter(Boolean))]`. Same styling as the existing source/medium filter chips.

### New routes: `/artist/:qid` and `/depicts/:qid`

`App.tsx` currently uses no router. Add a minimal hash-based route reader:

```typescript
// App.tsx
function parseRoute(): { page: 'home' | 'artist' | 'depicts'; qid?: string } {
  const hash = window.location.hash;
  const m = hash.match(/^#(artist|depicts)\/(Q\d+)$/);
  if (m) return { page: m[1] as 'artist' | 'depicts', qid: m[2] };
  return { page: 'home' };
}
```

Render `<ArtistPage qid={route.qid} />` or `<DepictsPage qid={route.qid} />` based on the route.

### `src/ArtistPage.tsx` and `src/DepictsPage.tsx` (new files)

Both follow the same pattern:
1. `useEffect` → fetch from `/api/artist?qid=<qid>` or `/api/depicts?qid=<qid>`
2. Show loading skeleton while fetching
3. Render entity header (portrait/image from Commons P18 URL if `imageCommons` is set), bio fields, work grid reusing the existing `ArtCard` component from Finder
4. Back button → `history.back()` or navigate to `#`

No new state management library. No new CSS framework. Pattern identical to `src/components/Discover.tsx`.

---

## What Is Deliberately NOT Built Yet

- **No Yale LUX / ArtKB integration** — bulk dumps not available.
- **No Europeana bulk ingest** — keep as live adapter only (rate-limited dump not publicly available).
- **No vector database** (Upstash Vector, pgvector, Cloudflare Vectorize) — `cluster_id` bakes similarity offline; runtime vectors add cost and complexity with no benefit.
- **No QLever self-hosting** — WDQS batched VALUES blocks are sufficient for the entity enrichment pass.
- **No runtime SPARQL from Vercel** — all graph data is pre-baked at ingest.
- **No WCQS OAuth** — P6243 Commons-to-artwork mapping is not needed in Phase 1 or 2; the existing `wikidataKey()` already handles Commons↔Wikidata identity via the `wd-Q…` id prefix.
- **No ArtGraph enrichment yet (Phase 4, optional)** — the CC-BY attribution requirement and the JW ≥ 0.88 threshold on a different-pipeline name source need validation before landing.
- **No `depicts_qids` as a nested list type** — flat VARCHAR, permanently. The HF filter API breakage makes this non-negotiable.
- **No new paid service of any kind.**

---

## Cost Analysis

| Component | Cost |
|---|---|
| HF dataset storage (train.parquet + entity JSON files, ~350 MB total) | Free (public dataset) |
| HF CDN entity file fetches at runtime | Free (static file serving, no query engine) |
| Upstash Redis entity cache (TTL 24h, ~1,200 cold loads/day headroom) | Free (existing, 10k cmd/day) |
| pHash clustering on CPU (~minutes for 1.4M thumbnails at 400px) | One-time electricity |
| CLIP ViT-H/14 on RX 6700 XT (~2h GPU for 1.4M images) | One-time electricity |
| WDQS batch queries at ingest (VALUES blocks of 50) | Free (Wikimedia public endpoint) |
| `name_to_qid.json` bundle in Vercel (~2 MB) | $0 (within 50 MB function limit) |
| Vercel cold-start overhead for JSON import | +15ms V8 parse, one-time per instance |
| **Total recurring** | **$0** |

---

## Phased Plan

### Phase 1 — Wikidata spine: schema extension, entity JSON build, name resolver  _(effort: M)_

**Scope:** 1a) Fix the local ArtItem re-declaration in Finder.tsx (import from @harpe/core, remove line 55 interface) — this unlocks all future field additions for free. 1b) Extend wikidata_sql() to extract wikidata_qid from the existing id column via regexp_extract — zero new SPARQL. 1c) Write harvest_wikidata_entities(): a separate SPARQL pass querying P170/P180/P195/P135 in VALUES blocks of 50 for all QIDs already in the JSONL, producing artist_qid, depicts_qids (flat space-separated VARCHAR), collection_qid, movement columns. 1d) Write build_entity_files(): reads distinct artist_qid values from the Parquet, batch-queries WDQS for artist metadata (labels, aliases, birth/death, nationality, P135, P245, P214, P18), builds data/artists/<QID>.json files, data/work_ids_by_artist/<QID>.json files, data/depicts/<QID>.json for subject entities, and name_to_qid.json (with suffix-suffix expansion, collision-drop, and raw: prefix for non-Latin scripts). 1e) Bundle name_to_qid.json in the repo at src/data/ and import it as a module-level constant in adapters.ts. 1f) Wire new columns through fetchDumpSearchUncached() row deserialization. 1g) Add resolveArtistQid() call for non-Wikidata rows in fetchDumpSearchUncached(). 1h) Add artistId, depicts, clusterId, movement to Fusable interface, MERGE_FILL_FIELDS, MERGE_UNION_FIELDS in search.ts. 1i) Add the byCluster union pass stub in dedupe() (no behavioral change until cluster_id column is non-null). 1j) Add all five field pass-throughs to normalizeArt() in Finder.tsx. No new API endpoints, no UI changes. Run existing test suite — zero regressions expected.

**Deliverable:** Wikidata dump-backed works carry wikidata_qid + artist_qid + depicts_qids + movement in the Parquet and in runtime ArtItem objects. Artist names from non-Wikidata live sources resolve to QIDs via the bundled name_to_qid.json. dedupe() uses QIDs (wikidataKey pass already works; artistId-driven merges now enabled via MERGE_FILL_FIELDS propagation). Entity JSON files (artists/, depicts/, work_ids_by_artist/) are live on HF CDN. normalizeArt() passes all five new fields through to dedupe(). Local ArtItem re-declaration is eliminated. Zero new endpoints, zero UI change.

### Phase 2 — /api/artist + /api/depicts endpoints + Finder UI wiring  _(effort: M)_

**Scope:** 2a) Write src/lib/server/handlers/artist.ts and depicts.ts using fetchArtistEntity(), fetchArtistWorkIds(), fetchSubjectEntity() from adapters.ts. Both use dumpHttpPolicy + Upstash Redis cache keyed entity:artist:<qid> / entity:depicts:<qid> (TTL 24h). Parallel fetch for artist (entity + workIds via Promise.all). 2b) Wire both handlers into src/lib/server/handlers/index.ts dispatch table. 2c) Add minimal hash-based route parser to App.tsx (parseRoute()). 2d) Implement src/ArtistPage.tsx and src/DepictsPage.tsx — useEffect fetch, loading skeleton, entity header with Commons portrait (where imageCommons is set), bio metadata, work grid reusing existing ArtCard styling. 2e) Convert artist button in Finder.tsx sidebar to navigate to /artist/<qid> when artistId is present. 2f) Convert tag spans to clickable buttons — QID tags navigate to /depicts/<qid>, non-QID tags fall back to onSearch(). 2g) Add movement filter chip to visibleArt useMemo filters and the filters row UI.

**Deliverable:** Full artist knowledge-graph browsing: click an artist name in any search result sidebar → artist page with bio metadata, portrait (if available from Wikidata P18), and a grid of their works from the dump. Click a depicts tag → subject entity page with description and all works depicting that entity. Movement filter chip in results panel. All powered by HF CDN static files + Upstash Redis cache at $0 recurring. Vercel function count unchanged (one catch-all).

### Phase 3 — Offline cluster_id for no-QID cross-source folding  _(effort: L)_

**Scope:** 3a) Add --cluster flag to ingest.py argparse. 3b) Write assign_cluster_ids(parquet_path) with checkpoint file (.cluster_state.json). Phase 3a (always-on when --cluster passed): download image_thumb URLs (not image_full) to a temp dir, run imagededup PHash.find_duplicates(), assign provisional cluster_id from connected components. Atomic write: new Parquet with cluster_id column replaces input path only after successful write. 3b) Phase 3b (--embed flag): download pHash-unresolved thumbnail shard, run open_clip ViT-H/14 inference on RX 6700 XT (ROCm 6.x), build FAISS HNSW index via autofaiss, union pairs at CLIP_SIM_THRESHOLD=0.92, title-mismatch veto (zero shared canonTitle tokens with both titles non-generic). 3c) Activate the byCluster union pass in dedupe() — the stub from Phase 1 becomes live. 3d) Validate against 20–30 known duplicate pairs before full run. Add ingest.py dependency guard: imagededup (CPU), open_clip + autofaiss (GPU, only when --embed). pHash step adds ~minutes to ingest for 1.4M items; GPU step ~2h, runs separately on demand.

**Deliverable:** Same-work folding across sources that share no QID and no identical image URL (e.g. different institutional photographs of the same physical painting). cluster_id column in Parquet. pHash phase runs on every --cluster ingest. GPU CLIP phase runs monthly or on demand via --embed. The byCluster dedupe pass is live with the title-mismatch veto. cluster_id is never exposed in URLs.

### Phase 4 — ArtGraph style/movement enrichment (optional, one-time)  _(effort: S)_

**Scope:** Download artgraph_v2.rdf.zip from Zenodo (12 MB, CC-BY 4.0). Write scripts/enrich-artgraph/enrich.py: parse RDF for artwork-style, artist-movement, artwork-emotion edges; fuzzy-match artist names (JW >= 0.88 against normalized name_to_qid keys, validated against ArtGraph-specific name variants before using the hyprwhspr threshold); patch style and movement columns in works Parquet and movement_labels in artist entity JSON files where currently NULL; tag patched rows with source_artgraph=true boolean. Surface CC-BY attribution (link to Castellano et al. 2022, DOI 10.1016/j.knosys.2022.108859) in Finder.tsx metadata sidebar for ArtGraph-sourced style/movement fields. Validate: sample 50 matched works, manually confirm artist identity. Do not ship until false-positive rate on name matching is measured to be < 5%.

**Deliverable:** Style, genre, and movement fields populated for the ~116k Western fine art works in the ArtGraph dataset that lack Wikidata P135/P136 coverage. CC-BY attribution surfaced inline for ArtGraph-sourced fields. No recurring dependency on ArtGraph (frozen dataset, one-time pass). JW threshold is validated for this specific source before landing.

---

## Key Decisions

- HF /filter WHERE is broken (HTTP 422 on live API for all predicate queries) — replaced with static JSON files per entity on the HF CDN, accessed via plain HTTPS GET. No query engine at runtime.
- depicts_qids stored as flat space-separated VARCHAR string, not VARCHAR[] list type — locks the schema before Phase 1 to avoid a full re-ingest if ARRAY_CONTAINS support is never added to the /filter API. Exact-token matching via /search + \bQxxx\b post-filter guard is safe because QIDs are unambiguous tokens in a space-separated string.
- name_to_qid.json bundled into the Vercel deployment (src/data/) as a static JSON import — eliminates the 200–500ms HF CDN cold-start fetch. At ~2 MB it is well under the 50 MB function bundle limit. V8 JSON.parse cost is ~15ms.
- Separate SPARQL pass (harvest_wikidata_entities) for P170/P180/P195 — NOT inline in _WD_QUERY. Inline GROUP_CONCAT(P180) would multiply result rows by the number of depicts targets per artwork, breaking the adaptive batch sizing that already fights WDQS truncation. VALUES blocks of 50 QIDs in a dedicated post-harvest pass avoid this entirely.
- wikidata_qid extracted from existing id column via regexp_extract('wd-(Q\d+)') — zero new SPARQL needed for the works table itself. The QID is already embedded in the existing id field for all Wikidata-source rows.
- Eliminated the local ArtItem re-declaration in Finder.tsx as a Phase 1 prerequisite — the two-place update tax (package interface + local interface + normalizeArt body) would apply to every new field in every phase. Fixing it once in Phase 1 makes all subsequent phases free.
- No HF multi-config (config=artist_entities) — configs require a non-trivial datasets-library push change and are moot anyway given the /filter WHERE breakage. Static files under data/ are simpler and confirmed working.
- Artist entity data served as one JSON file per QID (data/artists/Q41406.json) rather than a single large Parquet file — enables O(1) lookup by QID with no query engine, no Parquet parser dependency in the Vercel bundle, and no cold-start range request.
- Upstash Redis TTL for entity pages set to 24h (vs 5min for search results) — entity data (artist bio, depictions) changes only at ingest time, not per-query. 24h TTL maximizes cache hit rate and minimizes HF CDN round-trips for popular artists.
- cluster_id is an ephemeral INTEGER root index — never exposed in URLs, Redis keys, or user-facing state. External identity always uses wikidata_qid (stable) or canonical image identity. This constraint is enforced by the routing design (artist/depicts pages use /artist/:qid not /artist/:cluster_id).
- pHash clustering uses image_thumb (400px, already harvested) not image_full — avoids a multi-hundred-GB download of full-resolution images for the clustering step. imagededup works on local files; the thumb download is ~14GB for 1.4M items at 10KB average, feasible in a few hours.
- Title-mismatch veto in byCluster union pass: if both items have non-empty, non-generic titles sharing zero canonTitle tokens, CLIP merge is suppressed — guards against CLIP false positives on stylistically similar but distinct works (e.g. two different sunsets by different artists).
- ArtGraph enrichment (Phase 4) deferred and made optional — the JW >= 0.88 threshold was calibrated on museum API artist strings, not ArtGraph's RDF pipeline. Phase 4 requires explicit false-positive measurement before landing.
- Hash-based routing for artist/depicts pages (/#artist/Q41406) — consistent with the existing SPA structure (no React Router, no SSR), works with Vercel's existing SPA rewrite rules, and avoids adding a routing library dependency.
- Rejected: Cloudflare KV as entity store — adds a new infra dependency (Cloudflare account, KV namespace setup, wrangler). HF static files + Upstash Redis (already wired) achieve the same result with zero new accounts.
- Rejected: vector database for semantic deduplication — cluster_id bakes CLIP similarity offline. Runtime vector search adds recurring cost (Upstash Vector $0.4/100k queries at scale) and a hot-path latency dependency that the offline approach avoids entirely.

---

## Residual Risks

- HF CDN availability for entity files: if HF has an outage or rate-limits the CDN (unlikely for static files but possible), entity pages fail. Mitigation: Upstash Redis 24h TTL means warm pages are unaffected. Cold loads during an outage return 404/503 which the handler surfaces as 'artist not found' rather than crashing. No mitigation needed for a free-tier zero-infra project.
- name_to_qid.json collision rate: surname-only aliases (e.g. 'Smith', 'Martin') are excluded when they resolve to more than one QID — but the collision detection runs at ingest time against the known artist set. A future ingest adding a new artist with the same surname silently removes the suffix alias for both. The resolver returns undefined (falls back to plain artist name search) rather than wrong QID — a coverage gap, not a correctness bug.
- Upstash 10,000 cmd/day ceiling: at current traffic (~zero) this is irrelevant. At ~2,000 daily active users making entity page requests, the ceiling would be approached. The fix is the $10/month Upstash plan — appropriate when traffic justifies it. The architecture accommodates this without structural change.
- WDQS rate limits during entity enrichment pass: the harvest_wikidata_entities() function queries in VALUES blocks of 50 with the existing _retry() backoff logic. WDQS imposes a 60s query timeout and informal rate limits. At ~680k Wikidata artworks → ~13,600 batches → ~4 hours at 1 req/s. This is acceptable for a monthly re-run. The existing _WdRetryable + tenacity pattern handles transient failures; a crash resumes from a checkpoint.
- artist page work fetch quality: the artist handler fetches works via HF /search on the artist's label_en, then filters to known work IDs. For artists with common names ('Martin', 'Wang') the /search results may not include all works in the work_ids set within the first 100 results. Mitigation: store a separate work_ids_by_artist JSON file and cross-reference; for large catalogues (>100 works) pagination via multiple /search calls or a --top-N truncation is needed. This is a soft quality issue, not a data-loss issue.
- depicts post-filter precision: the \bQxxx\b regex guard prevents substring collisions within the space-separated depicts_qids string. However HF /search BM25 on a bare QID token may return works that mention the QID in other fields (e.g. source_url contains the QID). The post-filter on it.depicts?.some(d => qidRe.test(d)) catches this because depicts is derived only from depicts_qids at deserialization. Confirmed safe by the field-level filter.
- Phase 3 thumbnail download feasibility: 1.4M thumbnails at 400px average ~10KB = ~14GB download. At 10 Mbps that is ~3 hours. If HF or museum CDNs throttle the download, the checkpoint file allows resuming. The --cluster flag makes this opt-in and not a blocker for Phases 1 or 2.
- ArtGraph JW threshold false positives (Phase 4 only): the 0.88 threshold was validated on museum API strings. ArtGraph names come from a different scraping pipeline with different normalization. Until a sample of 50+ matched pairs is manually reviewed and the false-positive rate measured, Phase 4 should not ship. This is explicitly documented as a Phase 4 validation gate.
