# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.1", "huggingface_hub[hf_xet]>=0.34", "httpx>=0.27", "tqdm>=4.66", "tenacity>=8.5"]
# ///
"""
Ingest open-data museum DUMPS into one normalized Parquet, then (optionally) push
it to a Hugging Face dataset that the site queries via HF's keyless /search API.

We store METADATA ONLY (title, artist, date, medium, credit, image URLs, source
link) — never the images (those stay on the museums' servers; the site fetches
them on demand). So the Parquet is tens of MB of text and costs ~nothing to host.

Schema (one row per artwork, union "mega-model"):
  source, id, title, artist, date, medium, dimensions, culture, credit_line,
  description, image_thumb, image_full, width, height, source_url, rights_type,
  is_public_domain

Available source keys (see SOURCES registry at the bottom):
  moma nga          — always-on base (GitHub CC0 dumps)
  mia wellcome aic cleveland smk     — Tier A: drop-in CC0 dumps / single-file harvests
  met si wikidata                    — Tier B: harvested (API crawl / S3 art-units / SPARQL)

THE COMMAND (build every source in parallel + publish):
  huggingface-cli login                                          # once
  uv run scripts/ingest-art-dumps/ingest.py --push NullSense/harpe-art

That's it. It pulls ALL sources concurrently (one thread + DuckDB connection each,
so wall-time ≈ the single slowest source), then publishes to Hugging Face.

Safe by design — no footguns:
  • Each source is isolated: a failure (dead URL, WAF block, 0 rows) skips just that
    source; the rest still build and publish.
  • Publishing MERGES with the existing dataset: a source you didn't (or couldn't)
    build is kept from what's already live. No run can shrink the dataset.
  • Backfilling is the same command scoped down — it ADDS, never replaces:
      uv run scripts/ingest-art-dumps/ingest.py --sources met --push NullSense/harpe-art
  • Caches make re-runs fast; Met streams + resumes; Ctrl-C is safe.

Other flags: --sources a,b (subset) · --jobs N (cap parallelism) · --out FILE (local only).
Add a museum: write a SELECT yielding the union columns and register it in SOURCES.
"""
import argparse
import csv
import http.client
import io
import itertools
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb
import httpx
import tenacity
from tqdm import tqdm

logger = logging.getLogger("ingest")

# Cooperative cancellation: set on Ctrl-C so in-flight harvests stop promptly
# instead of the process hanging on non-daemon worker threads.
_ABORT = threading.Event()

# Each source runs in its own thread; this carries that thread's tqdm row so the
# concurrent progress bars stack cleanly instead of overwriting each other.
_tls = threading.local()


def _pbar(*args, **kwargs):
    """tqdm bound to the current source-thread's reserved screen row."""
    return tqdm(*args, position=getattr(_tls, "pos", None), leave=False, **kwargs)


class HarvestBlocked(RuntimeError):
    """A source's host is refusing automated access (WAF / rate-limit / IP block).

    Raised so build_parquet() can skip that one source cleanly and still build the
    rest, instead of hammering a dead endpoint and writing a junk/empty dump.
    """


# ─── Shared resilience helpers ───────────────────────────────────────────────

def _http_status(exc: BaseException):
    """Best-effort HTTP status from a urllib or httpx exception (else None)."""
    return getattr(exc, "code", None) or getattr(getattr(exc, "response", None), "status_code", None)


# Transient classes worth retrying (incl. a truncated/partial JSON body).
_TRANSIENT_EXC = (urllib.error.URLError, httpx.HTTPError, TimeoutError, OSError,
                  json.JSONDecodeError, http.client.HTTPException)  # incl. IncompleteRead


def _retry(what: str, fn, *, retries: int = 4, base_delay: float = 2.0):
    """Run fn() with exponential-backoff-plus-jitter retries (via `tenacity`).

    A definitive auth/rate-limit refusal (401/403/429/503) is surfaced as
    HarvestBlocked so the caller skips that source cleanly; 401/403 aren't retried
    (they won't fix themselves), while 429/503/connection blips are.
    """
    def _should_retry(state: tenacity.RetryCallState) -> bool:
        exc = state.outcome.exception()
        if exc is None or _http_status(exc) in (401, 403):
            return False
        return isinstance(exc, _TRANSIENT_EXC) or _http_status(exc) in (429, 503)

    runner = tenacity.Retrying(
        stop=tenacity.stop_after_attempt(retries),
        wait=tenacity.wait_exponential(multiplier=base_delay, max=60) + tenacity.wait_random(0, 1),
        retry=_should_retry,
        reraise=True,
    )
    try:
        return runner(fn)
    except Exception as exc:
        if _http_status(exc) in (401, 403, 429, 503):
            raise HarvestBlocked(f"{what}: host refused (HTTP {_http_status(exc)}).") from exc
        raise


def _atomic_dir(final: str) -> str:
    """Return a fresh scratch dir to fill; caller renames it onto `final` on success."""
    work = final + ".partial"
    if os.path.isdir(work):
        shutil.rmtree(work)
    os.makedirs(work, exist_ok=True)
    return work


def _commit_dir(work: str, final: str) -> None:
    if os.path.isdir(final):
        shutil.rmtree(final)
    os.replace(work, final)

# Raw dump locations (MoMA's JSON is Git-LFS → use the media. host, not raw.).
MOMA_JSON = "https://media.githubusercontent.com/media/MuseumofModernArt/collection/main/Artworks.json"
NGA_OBJECTS = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/objects.csv"
NGA_IMAGES = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/published_images.csv"

# MoMA: Artist is an array; flatten to a comma-joined string. MoMA's metadata
# dump is CC0, but MoMA explicitly excludes images from that CC0 release; keep
# image rows searchable, but do not label the image as public-domain/open-access.
MOMA_SQL = f"""
SELECT
  'moma' AS source,
  'moma-' || CAST("ObjectID" AS VARCHAR) AS id,
  COALESCE("Title", 'Untitled') AS title,
  array_to_string("Artist", ', ') AS artist,
  "Date" AS date,
  "Medium" AS medium,
  "Dimensions" AS dimensions,
  NULL AS culture,
  "CreditLine" AS credit_line,
  NULL AS description,
  "ImageURL" AS image_thumb,   -- MoMA dropped ThumbnailURL; ImageURL serves both
  "ImageURL" AS image_full,
  NULL AS width,
  NULL AS height,
  "URL" AS source_url,
  'metadata-cc0-image-rights-restricted' AS rights_type,
  FALSE AS is_public_domain
FROM read_json_auto('{MOMA_JSON}', maximum_object_size=1000000000)
WHERE "ImageURL" IS NOT NULL
"""

# NGA: join the image table to the object table; build IIIF full-size from the base.
NGA_SQL = f"""
SELECT
  'nga' AS source,
  'nga-' || CAST(o.objectid AS VARCHAR) AS id,
  COALESCE(o.title, 'Untitled') AS title,
  o.attribution AS artist,
  o.displaydate AS date,
  o.medium AS medium,
  o.dimensions AS dimensions,
  NULL AS culture,
  o.creditline AS credit_line,
  pi.assistivetext AS description,   -- NGA ships AI-generated alt-text per image
  pi.iiifthumburl AS image_thumb,
  pi.iiifurl || '/full/full/0/default.jpg' AS image_full,
  pi.width AS width,
  pi.height AS height,
  'https://www.nga.gov/collection/art-object-page.' || CAST(o.objectid AS VARCHAR) || '.html' AS source_url,
  'openaccess' AS rights_type,
  -- NGA's Open Access initiative (launched 2019) is NGA's own assertion that each
  -- work is in the public domain. They release these images under CC0, so
  -- openaccess=1 is a correct public-domain signal — not merely "freely usable
  -- under a Creative Commons license". We keep TRUE here intentionally; a birth-year
  -- heuristic would be less accurate than NGA's own legal determination.
  TRUE AS is_public_domain
FROM read_csv_auto('{NGA_OBJECTS}', ignore_errors=true) o
JOIN read_csv_auto('{NGA_IMAGES}', ignore_errors=true) pi
  ON pi.depictstmsobjectid = o.objectid
WHERE pi.openaccess = 1 AND pi.viewtype = 'primary'
"""

# MIA (Minneapolis Institute of Art): the artsmia/collection repo is SHARDED JSON —
# one file per object at objects/<id//1000>/<id>.json — so there's no single dump to
# read_json. We shallow-clone the repo (blob-filtered) and read_json_auto over the
# glob. Images come from MIA's image API by id; we keep only works whose image is
# 'valid' and that are NOT restricted (restricted=0 → free to reuse). Metadata is CC0.
MIA_REPO = "https://github.com/artsmia/collection.git"


def mia_sql(repo_dir: str) -> str:
    glob = os.path.join(repo_dir, "objects", "*", "*.json").replace("'", "''")
    # An EXPLICIT schema is required: read_json_auto's inference collapses to a
    # single `json` column across the ~196k-file glob. Specifying `columns` skips
    # inference (and reads only the keys we need; the rest are ignored).
    cols = (
        "{'id': 'VARCHAR', 'title': 'VARCHAR', 'artist': 'VARCHAR', 'dated': 'VARCHAR', "
        "'medium': 'VARCHAR', 'dimension': 'VARCHAR', 'culture': 'VARCHAR', "
        "'creditline': 'VARCHAR', 'description': 'VARCHAR', 'text': 'VARCHAR', "
        "'image': 'VARCHAR', 'restricted': 'BIGINT', 'rights_type': 'VARCHAR', "
        "'image_width': 'BIGINT', 'image_height': 'BIGINT'}"
    )
    return f"""
SELECT
  'mia' AS source,
  'mia-' || id AS id,
  COALESCE(NULLIF(title, ''), 'Untitled') AS title,
  COALESCE(artist, '') AS artist,
  dated AS date,
  medium AS medium,
  dimension AS dimensions,
  culture AS culture,
  creditline AS credit_line,
  COALESCE(NULLIF(description, ''), text) AS description,
  'https://api.artsmia.org/images/' || id || '/medium.jpg' AS image_thumb,
  'https://api.artsmia.org/images/' || id || '/large.jpg' AS image_full,
  image_width AS width,
  image_height AS height,
  'https://collections.artsmia.org/art/' || id AS source_url,
  rights_type AS rights_type,
  COALESCE(restricted = 0 AND LOWER(COALESCE(rights_type, '')) IN ('public domain', 'no copyright'), FALSE) AS is_public_domain
FROM read_json('{glob}', columns={cols}, format='auto', records='true', ignore_errors=true)
WHERE image = 'valid' AND restricted = 0 AND id IS NOT NULL
"""


# Wellcome Collection: a single daily-regenerated JSONL.gz snapshot of the whole
# images catalogue (~127k images, ~32 MB) — the cleanest possible dump. Each line
# is one image record in the live Catalogue-API serialisation; we pull the IIIF id
# out of the info.json URL and rebuild full/thumb URLs from it. Metadata is open;
# image rights are per-record (pdm/cc0/cc-by/… → open; we keep all view-online-open
# items searchable and only flag is_public_domain for pdm/cc0).
WELLCOME_JSON = "https://data.wellcomecollection.org/catalogue/v2/images.json.gz"

WELLCOME_SQL = f"""
WITH src AS (
  SELECT json AS j FROM read_json_objects('{WELLCOME_JSON}', format='newline_delimited')
),
x AS (
  SELECT
    j->>'id' AS img_id,
    j->'source'->>'id' AS work_id,
    COALESCE(j->'source'->>'title', 'Untitled') AS title,
    COALESCE(j->'source'->'contributors'->0->'agent'->>'label', '') AS artist,
    regexp_extract(j->'locations'->0->>'url', 'image/([^/]+)/info.json', 1) AS iiif_id,
    j->'locations'->0->'license'->>'label' AS rights_label,
    j->'locations'->0->'license'->>'id' AS lic_id,
    j->'locations'->0->>'credit' AS credit
  FROM src
)
SELECT
  'wellcome' AS source,
  'wellcome-' || img_id AS id,
  title,
  artist,
  NULL AS date,
  NULL AS medium,
  NULL AS dimensions,
  NULL AS culture,
  credit AS credit_line,
  NULL AS description,
  'https://iiif.wellcomecollection.org/image/' || iiif_id || '/full/!400,400/0/default.jpg' AS image_thumb,
  'https://iiif.wellcomecollection.org/image/' || iiif_id || '/full/full/0/default.jpg' AS image_full,
  NULL AS width,
  NULL AS height,
  'https://wellcomecollection.org/works/' || work_id AS source_url,
  COALESCE(rights_label, 'open') AS rights_type,
  COALESCE(lic_id IN ('pdm', 'cc0'), FALSE) AS is_public_domain
FROM x
WHERE iiif_id IS NOT NULL AND iiif_id <> ''
"""


def clone_mia() -> str:
    """Shallow blob-filtered clone of the MIA collection into a temp dir; returns it.

    Clones into a .partial dir and commits on success, with retry — a failed/partial
    clone never leaves an `objects/` tree that the reuse-check mistakes for complete.
    """
    dest = os.path.join(tempfile.gettempdir(), "harpe-mia-collection")
    objects = os.path.join(dest, "objects")
    if os.path.isdir(objects) and os.listdir(objects):
        print(f"Reusing existing MIA clone at {dest} (delete it to re-pull).")
        return dest

    def _clone():
        work = _atomic_dir(dest)
        # _atomic_dir pre-creates the dir; git clone needs it absent.
        shutil.rmtree(work)
        subprocess.run(
            ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", MIA_REPO, work],
            check=True,
        )
        subprocess.run(["git", "-C", work, "sparse-checkout", "set", "objects"], check=True)
        if not os.listdir(os.path.join(work, "objects")):
            shutil.rmtree(work, ignore_errors=True)
            raise RuntimeError("MIA clone produced no objects/")
        _commit_dir(work, dest)
        return dest

    print(f"Cloning MIA collection (shallow, blob-filtered) → {dest} …")
    return _retry("MIA clone", _clone, retries=3, base_delay=3.0)


# ─── AIC (Art Institute of Chicago) ──────────────────────────────────────────
# Full data dump, one JSON file per artwork. ~115 MB bz2 → ~590 MB extracted
# (~134k files). Metadata CC0; is_public_domain is AIC's own per-work assertion.
AIC_DUMP_URL = "https://artic-api-data.s3.amazonaws.com/artic-api-data.tar.bz2"


def clone_aic() -> str:
    """Download + extract the AIC bulk dump into a temp dir; returns the dir.

    Downloads to a .part file and extracts into a .partial dir, committing only on
    success — an interrupted pull never leaves a half-dump that looks complete.
    """
    import tarfile
    dest = os.path.join(tempfile.gettempdir(), "harpe-aic-data")
    artworks_dir = os.path.join(dest, "artic-api-data", "json", "artworks")
    if os.path.isdir(artworks_dir) and os.listdir(artworks_dir):
        print(f"Reusing existing AIC dump at {dest} (delete it to re-pull).")
        return dest

    work = _atomic_dir(dest)
    archive = os.path.join(work, "artic-api-data.tar.bz2.part")
    print(f"Downloading AIC dump (~115 MB) → {archive} …")
    _retry("AIC dump", lambda: urllib.request.urlretrieve(AIC_DUMP_URL, archive))
    print("Extracting …")
    try:
        with tarfile.open(archive, "r:bz2") as tf:
            tf.extractall(work)
    except (tarfile.TarError, EOFError, OSError) as e:
        shutil.rmtree(work, ignore_errors=True)
        raise HarvestBlocked(f"AIC dump corrupt/incomplete ({e}); discarded.")
    os.remove(archive)
    extracted = os.path.join(work, "artic-api-data", "json", "artworks")
    if not (os.path.isdir(extracted) and os.listdir(extracted)):
        shutil.rmtree(work, ignore_errors=True)
        raise HarvestBlocked("AIC dump missing json/artworks after extract; discarded.")
    _commit_dir(work, dest)
    return dest


def aic_sql(dump_dir: str) -> str:
    glob = os.path.join(dump_dir, "artic-api-data", "json", "artworks", "*.json").replace("'", "''")
    # Explicit columns: read_json_auto collapses to a single `json` column across
    # the ~134k-file glob (same issue as MIA). `thumbnail` is a STRUCT.
    cols = (
        "{'id': 'INTEGER', 'title': 'VARCHAR', 'artist_display': 'VARCHAR', "
        "'date_display': 'VARCHAR', 'medium_display': 'VARCHAR', 'dimensions': 'VARCHAR', "
        "'place_of_origin': 'VARCHAR', 'credit_line': 'VARCHAR', 'description': 'VARCHAR', "
        "'image_id': 'VARCHAR', 'is_public_domain': 'BOOLEAN', "
        "'thumbnail': 'STRUCT(width INTEGER, height INTEGER)'}"
    )
    return f"""
WITH src AS (
  SELECT * FROM read_json('{glob}', columns={cols}, format='auto')
  WHERE image_id IS NOT NULL AND image_id <> ''
)
SELECT
  'aic' AS source,
  'aic-' || CAST(id AS VARCHAR) AS id,
  COALESCE(title, 'Untitled') AS title,
  COALESCE(artist_display, '') AS artist,
  date_display AS date,
  medium_display AS medium,
  dimensions AS dimensions,
  place_of_origin AS culture,
  credit_line AS credit_line,
  description AS description,
  'https://www.artic.edu/iiif/2/' || image_id || '/full/400,/0/default.jpg' AS image_thumb,
  'https://www.artic.edu/iiif/2/' || image_id || '/full/843,/0/default.jpg' AS image_full,
  thumbnail.width AS width,
  thumbnail.height AS height,
  'https://www.artic.edu/artworks/' || CAST(id AS VARCHAR) AS source_url,
  CASE WHEN is_public_domain THEN 'CC0' ELSE 'copyright' END AS rights_type,
  COALESCE(is_public_domain, FALSE) AS is_public_domain
FROM src
"""


# ─── Cleveland Museum of Art ──────────────────────────────────────────────────
# Single ~117 MB JSON array (LFS via media host). Metadata + PD images are CC0.
CLEVELAND_URL = "https://media.githubusercontent.com/media/ClevelandMuseumArt/openaccess/master/data.json"

CLEVELAND_SQL = f"""
SELECT
    'cleveland' AS source,
    'cleveland-' || CAST(r.id AS VARCHAR) AS id,
    r.title AS title,
    COALESCE(r.creators[1].description, r.creators[1].id::VARCHAR) AS artist,
    r.creation_date AS date,
    r.technique AS medium,
    r.measurements AS dimensions,
    CASE WHEN array_length(r.culture) > 0 THEN array_to_string(r.culture, ', ') ELSE NULL END AS culture,
    r.creditline AS credit_line,
    r.description AS description,
    r.images.web.url AS image_thumb,
    COALESCE(r.images.print.url, r.images."full".url) AS image_full,
    NULL::INTEGER AS width,
    NULL::INTEGER AS height,
    r.url AS source_url,
    r.share_license_status AS rights_type,
    (r.share_license_status = 'CC0') AS is_public_domain
FROM read_json('{CLEVELAND_URL}', maximum_object_size=200000000, format='array') AS r
WHERE r.images IS NOT NULL
"""


# ─── SMK (National Gallery of Denmark) ────────────────────────────────────────
# No stable ZIP URL → page the keyless REST API into a JSONL, then read it.
SMK_SEARCH = (
    "https://api.smk.dk/api/v1/art/search/"
    "?keys=*&filters=%5Bhas_image%3Atrue%5D&rows=2000&lang=en&offset={offset}"
)


def harvest_smk() -> str:
    """Page the SMK search API until exhausted; return path to the JSONL.

    Each page is fetched with retry/backoff; the JSONL is written to a .tmp and
    renamed only on full completion, so a dropped connection never caches a
    truncated harvest.
    """
    dest = os.path.join(tempfile.gettempdir(), "harpe-smk.jsonl")
    if os.path.exists(dest):
        print(f"Reusing existing SMK harvest at {dest} (delete to re-harvest).")
        return dest
    print("Harvesting SMK (National Gallery of Denmark) via REST API …")
    tmp = dest + ".tmp"
    total_written, found, offset = 0, None, 0

    def _page(off):
        req = urllib.request.Request(SMK_SEARCH.format(offset=off),
                                     headers={"User-Agent": "harpe-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)

    try:
        with open(tmp, "w") as f:
            while True:
                data = _retry(f"SMK offset={offset}", lambda: _page(offset))
                if found is None:
                    found = data["found"]
                    print(f"  SMK total: {found:,} images")
                items = data.get("items", [])
                for item in items:
                    f.write(json.dumps(item) + "\n")
                total_written += len(items)
                offset += len(items)
                print(f"  offset={offset}/{found} ({total_written:,} written)")
                if offset >= found or not items:
                    break
                time.sleep(0.2)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    if total_written == 0:
        os.remove(tmp)
        raise HarvestBlocked("SMK: harvested 0 rows — not caching.")
    os.replace(tmp, dest)
    print(f"SMK harvest done: {total_written:,} rows → {dest}")
    return dest


def smk_sql(jsonl_path: str) -> str:
    p = jsonl_path.replace("'", "''")
    return f"""
WITH raw AS (
  SELECT * FROM read_json('{p}', format='newline_delimited')
)
SELECT
  'smk' AS source,
  'smk-' || id AS id,
  COALESCE(
    list_filter(titles, x -> lower(x.language) IN ('engelsk', 'english'))[1].title,
    titles[1].title, 'Untitled'
  ) AS title,
  COALESCE(
    production[1].creator,
    NULLIF(TRIM(COALESCE(production[1].creator_forename, '') || ' ' ||
                COALESCE(production[1].creator_surname, '')), ''), ''
  ) AS artist,
  production_date[1].period AS date,
  array_to_string(techniques, '; ') AS medium,
  (SELECT array_to_string(LIST(d.value || ' ' || d.unit ORDER BY d."type"), ' x ')
   FROM UNNEST(dimensions) AS t(d)) AS dimensions,
  NULL::VARCHAR AS culture,
  rights AS credit_line,
  NULL::VARCHAR AS description,
  image_thumbnail AS image_thumb,
  COALESCE(image_native, image_iiif_id || '/full/full/0/default.jpg') AS image_full,
  image_width AS width,
  image_height AS height,
  frontend_url AS source_url,
  rights AS rights_type,
  COALESCE(public_domain, FALSE) AS is_public_domain
FROM raw
WHERE image_thumbnail IS NOT NULL
"""


# ─── The Metropolitan Museum of Art ──────────────────────────────────────────
# The Met collection API (collectionapi.metmuseum.org) sits behind an Imperva
# bot-wall, so we do NOT crawl it. Instead we read the Met's OWN official Hugging
# Face dataset (metmuseum/openaccess) — ~260k public-domain works with image URLs
# already baked in. The image CDN (images.metmuseum.org) is NOT walled, so those
# URLs hotlink fine. Zero crawling, no key.
MET_HF_PARQUET_API = "https://huggingface.co/api/datasets/metmuseum/openaccess/parquet/default/train"


def harvest_met_dump() -> str:
    """Read the Met's official HF open-access parquet shards → JSONL (public-domain
    rows that have a primaryImage). No Met API calls — every URL comes from HF."""
    out_path = os.path.join(tempfile.gettempdir(), "harpe-met.jsonl")
    if os.path.exists(out_path):
        print(f"Reusing existing Met dump at {out_path} (delete to re-harvest).")
        return out_path

    def _shards():
        req = urllib.request.Request(MET_HF_PARQUET_API, headers={"User-Agent": "harpe-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    shard_urls = _retry("Met HF shards", _shards)
    if not shard_urls:
        raise HarvestBlocked("Met: HF parquet API returned no shards.")
    print(f"Met dump: reading {len(shard_urls)} HF parquet shards …")

    tmp = out_path + ".tmp"
    written = 0
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"SET temp_directory='{tempfile.gettempdir()}';")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            for i, shard in enumerate(shard_urls, 1):
                rows = con.execute(f"""
                    SELECT objectID, title, artistDisplayName, objectDate, medium,
                           dimensions, culture, creditLine, primaryImage, primaryImageSmall, objectURL
                    FROM read_parquet('{shard.replace(chr(39), chr(39) * 2)}')
                    WHERE isPublicDomain = TRUE AND primaryImage IS NOT NULL AND primaryImage <> ''
                """).fetchall()
                for (oid, title, artist, date, medium, dims, culture, credit, full, small, url) in rows:
                    fh.write(json.dumps({
                        "source": "met", "id": f"met-{oid}",
                        "title": (title or "").strip() or "Untitled",
                        "artist": (artist or "").strip() or None,
                        "date": (date or "").strip() or None,
                        "medium": (medium or "").strip() or None,
                        "dimensions": (dims or "").strip() or None,
                        "culture": (culture or "").strip() or None,
                        "credit_line": (credit or "").strip() or None,
                        "description": None,
                        "image_thumb": (small or "").strip() or (full or "").strip(),
                        "image_full": (full or "").strip(),
                        "width": None, "height": None,
                        "source_url": (url or "").strip() or None,
                        "rights_type": "CC0", "is_public_domain": True,
                    }, ensure_ascii=False) + "\n")
                    written += 1
                print(f"  Met shard {i}/{len(shard_urls)} → {written:,} rows")
    except Exception:
        con.close()
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    con.close()
    if written == 0:
        os.remove(tmp)
        raise HarvestBlocked("Met: 0 public-domain rows with images in the HF dataset.")
    os.replace(tmp, out_path)
    print(f"Met dump done: {written:,} rows → {out_path}")
    return out_path


def met_sql(jsonl_path: str) -> str:
    p = jsonl_path.replace("'", "''")
    return f"SELECT * FROM read_json_auto('{p}', format='newline_delimited')"


# ─── Smithsonian Open Access (CC0) ───────────────────────────────────────────
# 17M records across many units → fetch only the 8 ART units' S3 files (00..ff),
# then filter to CC0+has-image. Full art pull ≈ 2,048 files / ~350 MB.
SI_ART_UNITS = ["saam", "npg", "fsg", "hmsg", "chndm", "nmafa", "nmaahc", "nmai"]
SI_BASE_URL = "https://smithsonian-open-access.s3-us-west-2.amazonaws.com/metadata/edan"
SI_BUCKETS = [f"{i:02x}" for i in range(256)]


def download_si_art() -> str:
    """Download every 00.txt–ff.txt for the 8 SI art units into a temp dir; returns it.

    Tolerant: a 404 bucket (legitimately empty) is skipped, transient errors retry,
    and the download only commits (atomic dir rename) if the failure rate stays low.
    """
    dest = os.path.join(tempfile.gettempdir(), "harpe-si-art")
    if os.path.isdir(dest) and os.listdir(dest):
        print(f"Reusing existing SI download at {dest} (delete to re-pull).")
        return dest

    work = _atomic_dir(dest)
    urls = [(u, b, f"{SI_BASE_URL}/{u}/{b}.txt")
            for u, b in itertools.product(SI_ART_UNITS, SI_BUCKETS)]
    print(f"Downloading Smithsonian art units ({len(urls)} files) …")

    def fetch(args):
        unit, bucket, url = args
        out = os.path.join(work, f"{unit}_{bucket}.txt")

        def _go():
            with httpx.stream("GET", url, timeout=60, follow_redirects=True) as r:
                if r.status_code == 404:
                    return "missing"          # legitimately empty bucket — skip
                r.raise_for_status()
                with open(out, "wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
            return "ok"

        try:
            return _retry(f"SI {unit}/{bucket}", _go, retries=3)
        except HarvestBlocked:
            return "blocked"
        except Exception:
            return "error"

    tally = {"ok": 0, "missing": 0, "blocked": 0, "error": 0}
    with ThreadPoolExecutor(max_workers=24) as pool:
        futs = [pool.submit(fetch, u) for u in urls]
        for fut in _pbar(as_completed(futs), total=len(futs), unit="file", desc="Smithsonian"):
            if _ABORT.is_set():
                shutil.rmtree(work, ignore_errors=True)
                raise KeyboardInterrupt
            tally[fut.result()] += 1

    failed = tally["blocked"] + tally["error"]
    logger.info("SI download: %d ok, %d empty, %d failed", tally["ok"], tally["missing"], failed)
    if tally["ok"] == 0:
        shutil.rmtree(work, ignore_errors=True)
        raise HarvestBlocked("Smithsonian: every art-unit file failed to download — discarded.")
    if failed > len(urls) * 0.2:
        shutil.rmtree(work, ignore_errors=True)
        raise HarvestBlocked(f"Smithsonian: {failed}/{len(urls)} files failed (>20%) — discarded as unreliable.")
    _commit_dir(work, dest)
    return dest


def si_sql(glob: str) -> str:
    return f"""
WITH filtered AS (
    SELECT json FROM read_json_objects({glob!r})
    WHERE json_extract_string(json, '$.content.descriptiveNonRepeating.online_media.media[0].usage.access') = 'CC0'
      AND json_extract_string(json, '$.content.descriptiveNonRepeating.online_media.media[0].thumbnail') IS NOT NULL
),
with_jpeg AS (
    SELECT json,
        list_filter(
            CAST(json->'content'->'descriptiveNonRepeating'->'online_media'->'media'->0->'resources' AS JSON[]),
            x -> json_extract_string(x, '$.label') = 'High-resolution JPEG'
        )[1] AS jpeg_res
    FROM filtered
)
SELECT
    'si' AS source,
    'si-' || json_extract_string(json, '$.content.descriptiveNonRepeating.record_ID') AS id,
    COALESCE(
        json_extract_string(json, '$.content.descriptiveNonRepeating.title.content'),
        json_extract_string(json, '$.title')
    ) AS title,
    json_extract_string(json, '$.content.freetext.name[0].content') AS artist,
    json_extract_string(json, '$.content.freetext.date[0].content') AS date,
    json_extract_string(json, '$.content.freetext.physicalDescription[0].content') AS medium,
    json_extract_string(json, '$.content.freetext.physicalDescription[1].content') AS dimensions,
    NULL::VARCHAR AS culture,
    json_extract_string(json, '$.content.freetext.creditLine[0].content') AS credit_line,
    NULL::VARCHAR AS description,
    json_extract_string(json, '$.content.descriptiveNonRepeating.online_media.media[0].thumbnail') AS image_thumb,
    json_extract_string(json, '$.content.descriptiveNonRepeating.online_media.media[0].content') AS image_full,
    TRY_CAST(json_extract_string(jpeg_res, '$.width')  AS INTEGER) AS width,
    TRY_CAST(json_extract_string(jpeg_res, '$.height') AS INTEGER) AS height,
    json_extract_string(json, '$.content.descriptiveNonRepeating.record_link') AS source_url,
    'CC0' AS rights_type,
    TRUE AS is_public_domain
FROM with_jpeg
"""


# ─── Wikidata ─────────────────────────────────────────────────────────────────
# Harvest the artwork subset via WDQS SPARQL (60 s/query timeout → page by 5000,
# ~1 req/s). 4 classes; dedup by QID across classes. ~680k items, ~25 min.
_WDQS = "https://query.wikidata.org/sparql"
_WD_UA = "HarpeArtIngest/1.0 (github.com/NullSense/harpe; matas234@gmail.com)"
_WD_CLASSES = [("Q3305213", "painting"), ("Q860861", "sculpture"),
               ("Q11060274", "print"), ("Q93184", "drawing")]
_WD_PD_ENTITY = "http://www.wikidata.org/entity/Q19652"
_WD_QUERY = """\
SELECT ?item ?itemLabel ?creatorLabel ?inception ?materialLabel
       ?collectionLabel ?image ?copyright WHERE {{
  ?item wdt:P31 wd:{cls} ; wdt:P18 ?image .
  OPTIONAL {{ ?item wdt:P170 ?creator . }}
  OPTIONAL {{ ?item wdt:P571 ?inception . }}
  OPTIONAL {{ ?item wdt:P186 ?material . }}
  OPTIONAL {{ ?item wdt:P195 ?collection . }}
  OPTIONAL {{ ?item wdt:P6216 ?copyright . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" . }}
}} LIMIT {limit} OFFSET {offset}
"""


class _WdTruncated(Exception):
    """WDQS returned a partial/oversized body (timed out mid-stream) — the caller
    should shrink the batch and re-fetch the SAME offset, not skip or retry as-is."""


class _WdRetryable(Exception):
    """A transient WDQS condition (429/503/connection) — worth a backed-off retry."""


@tenacity.retry(
    retry=tenacity.retry_if_exception_type(_WdRetryable),
    stop=tenacity.stop_after_attempt(6),
    wait=tenacity.wait_exponential(multiplier=3, max=60) + tenacity.wait_random(0, 2),
    reraise=True,
)
def _wd_fetch(client, cls, limit, offset):
    """Fetch one WDQS page. tenacity retries transient conditions (429 + any 5xx
    gateway error — WDQS throws 502/504 constantly at deep offsets — and connection
    blips) with backoff; raises _WdTruncated on a partial JSON body (→ caller
    shrinks the batch) and HarvestBlocked on a persistent refusal."""
    q = _WD_QUERY.format(cls=cls, limit=limit, offset=offset)
    try:
        resp = client.get(_WDQS, params={"query": q},
                          headers={"Accept": "application/sparql-results+json", "User-Agent": _WD_UA},
                          timeout=90)
    except (httpx.TransportError, httpx.TimeoutException, OSError) as e:
        raise _WdRetryable(str(e)) from e
    if resp.status_code == 429 or resp.status_code >= 500:
        raise _WdRetryable(f"HTTP {resp.status_code}")
    if resp.status_code in (401, 403):
        raise HarvestBlocked(f"Wikidata WDQS refused (HTTP {resp.status_code}).")
    resp.raise_for_status()
    try:
        # strict=False: WDQS labels can embed raw control chars that strict JSON
        # rejects; json.dumps re-escapes them when we write the row.
        return json.loads(resp.text, strict=False)["results"]["bindings"]
    except json.JSONDecodeError as e:
        raise _WdTruncated(str(e)) from e   # oversized/timed-out page → shrink


# Adaptive batch sizing (AIMD, à la TCP congestion control): grow the page after
# a clean fetch, halve it the moment WDQS truncates, so the harvester self-tunes to
# whatever the endpoint can serve under its 60s timeout right now.
_WD_BATCH_START, _WD_BATCH_MIN, _WD_BATCH_MAX, _WD_BATCH_STEP = 2000, 200, 5000, 1000


def harvest_wikidata(max_batches=None) -> str:
    """Page WDQS for artworks-with-image; dedup by QID; write JSONL. Resumable.

    Auto-tunes the page size: shrink-and-retry the SAME offset on truncation (so no
    rows are lost), grow back on success. Streams to a `.partial` + per-class offset
    state, so Ctrl-C / a crash / a hard WDQS refusal all keep progress — re-running
    resumes where it left off.
    """
    out_path = os.path.join(tempfile.gettempdir(), "harpe-wikidata.jsonl")
    if os.path.exists(out_path):
        print(f"Reusing existing Wikidata harvest at {out_path} (delete to re-harvest).")
        return out_path
    partial = out_path + ".partial"
    state_path = out_path + ".state.json"

    seen, total, offsets = set(), 0, {}
    if os.path.exists(partial):
        with open(partial, encoding="utf-8") as f:
            for line in f:
                try:
                    seen.add(json.loads(line)["id"])
                    total += 1
                except Exception:
                    pass
        try:
            offsets = json.load(open(state_path, encoding="utf-8"))
        except Exception:
            offsets = {}
        print(f"Resuming Wikidata: {total:,} already harvested.")

    bar = _pbar(unit="art", desc="Wikidata", initial=total, smoothing=0.1)
    print("Wikidata: querying WDQS (page size auto-tunes; first page ~10-20s)…")
    try:
        with httpx.Client(follow_redirects=True) as client, open(partial, "a", encoding="utf-8") as fh:
            for cls, label in _WD_CLASSES:
                offset = offsets.get(cls, 0)
                batch = _WD_BATCH_START
                min_fails = 0
                while True:
                    if _ABORT.is_set():
                        raise KeyboardInterrupt
                    if max_batches is not None and offset // _WD_BATCH_START >= max_batches:
                        break
                    bar.set_postfix_str(f"{label} ·{batch}", refresh=False)
                    try:
                        bindings = _wd_fetch(client, cls, batch, offset)
                    except _WdTruncated:
                        if batch > _WD_BATCH_MIN:                  # shrink, retry SAME offset
                            batch = max(_WD_BATCH_MIN, batch // 2)
                            continue
                        min_fails += 1                            # already tiny and still failing
                        if min_fails >= 8:
                            raise HarvestBlocked(
                                f"Wikidata WDQS failing even at min page size ({label}@{offset}); "
                                "progress saved — re-run to resume.")
                        offset += batch                           # skip this small window, move on
                        offsets[cls] = offset
                        continue
                    except _WdRetryable as e:
                        # Transient server error (504/502/…) survived all retries at this
                        # offset — skip the window and keep going rather than abort the whole
                        # harvest. Resume/re-run + merge-on-push fills any skipped gaps.
                        min_fails += 1
                        tqdm.write(f"  wikidata: {label}@{offset} {e}; skipping window")
                        if min_fails >= 8:
                            raise HarvestBlocked(
                                f"Wikidata WDQS failing repeatedly ({label}@{offset}); "
                                "progress saved — re-run to resume.")
                        offset += batch
                        offsets[cls] = offset
                        time.sleep(3)
                        continue
                    min_fails = 0
                    if not bindings:
                        break
                    new = 0
                    for b in bindings:
                        wid = "wd-" + b["item"]["value"].split("/")[-1]
                        if wid in seen:
                            continue
                        image = b.get("image", {}).get("value", "")
                        if not image:
                            continue
                        seen.add(wid)
                        inception = b.get("inception", {}).get("value", "")
                        is_pd = b.get("copyright", {}).get("value", "") == _WD_PD_ENTITY
                        fh.write(json.dumps({
                            "source": "wikidata", "id": wid,
                            "title": b.get("itemLabel", {}).get("value") or None,
                            "artist": b.get("creatorLabel", {}).get("value") or None,
                            "date": inception[:4] if inception else None,
                            "medium": b.get("materialLabel", {}).get("value") or None,
                            "dimensions": None, "culture": None,
                            "credit_line": b.get("collectionLabel", {}).get("value") or None,
                            "description": None,
                            "image_thumb": image + "?width=400", "image_full": image,
                            "width": None, "height": None,
                            "source_url": "https://www.wikidata.org/wiki/" + wid[3:],
                            "rights_type": "public domain" if is_pd else "unknown",
                            "is_public_domain": is_pd,
                        }) + "\n")
                        new += 1
                    total += new
                    offset += batch
                    offsets[cls] = offset
                    fh.flush()
                    json.dump(offsets, open(state_path, "w", encoding="utf-8"))
                    bar.update(new)
                    batch = min(_WD_BATCH_MAX, batch + _WD_BATCH_STEP)  # grow back on success
                    time.sleep(0.3)
    except KeyboardInterrupt:
        bar.close()
        print(f"\n⏸  Wikidata interrupted — {total:,} saved to {partial}. Re-run to resume.")
        raise                                         # Ctrl-C means stop the whole run
    except (HarvestBlocked, Exception) as e:
        # GREEDY: a failure mid-harvest (WDQS gave up, network died, …) does NOT
        # throw away what we already pulled. Keep the partial + state for resume,
        # and fall through to ingest the salvaged rows so this build still gets them.
        bar.close()
        incomplete = str(e) or type(e).__name__
    else:
        bar.close()
        incomplete = None

    if total == 0:
        for f in (partial, state_path):
            if os.path.exists(f):
                os.remove(f)
        if incomplete:
            raise HarvestBlocked(f"Wikidata: 0 rows harvested ({incomplete}).")
        raise HarvestBlocked("Wikidata: harvested 0 rows — not caching.")

    if incomplete:
        # Salvage: hand back the partial as-is (NOT renamed to the final cache) so
        # this build ingests the rows we got AND the next run resumes from here.
        print(f"[wikidata] INCOMPLETE ({incomplete}) — ingesting {total:,} salvaged rows; "
              f"re-run `--sources wikidata --push` to continue from where it stopped.")
        return partial

    os.replace(partial, out_path)
    if os.path.exists(state_path):
        os.remove(state_path)
    print(f"[wikidata] done — {total:,} unique artworks → {out_path}")
    return out_path


def wikidata_sql(jsonl_path: str) -> str:
    p = jsonl_path.replace("'", "''")
    cols = ("{source:'VARCHAR',id:'VARCHAR',title:'VARCHAR',artist:'VARCHAR',date:'VARCHAR',"
            "medium:'VARCHAR',dimensions:'VARCHAR',culture:'VARCHAR',credit_line:'VARCHAR',"
            "description:'VARCHAR',image_thumb:'VARCHAR',image_full:'VARCHAR',width:'INTEGER',"
            "height:'INTEGER',source_url:'VARCHAR',rights_type:'VARCHAR',is_public_domain:'BOOLEAN'}")
    # Extract the knowledge-graph spine QID from the existing `wd-Q…` id at zero
    # SPARQL cost (the harvest already wrote it). Lets dedupe() fold Wikidata works
    # with the Commons P6243 QID and across languages; other sources read
    # `union_by_name` NULL for this column. artist_qid/depicts_qids/movement come
    # from a separate entity-enrichment pass (future ingest step; see notes/).
    return (
        f"SELECT *, regexp_extract(id, '^wd-(Q[0-9]+)$', 1) AS wikidata_qid "
        f"FROM read_json('{p}', format='newline_delimited', columns={cols})"
    )


# ─── Library of Congress (Prints & Photographs) ──────────────────────────────
# Keyless JSON API; IIIF images on tile.loc.gov hotlink (CORS *). No single dump —
# slice by year windows (deep paging caps ~10k pages/query) and page each politely
# (~20 req/min). Default caps each window for a tractable ~tens-of-k first cut;
# set LOC_SAMPLE_PAGES = None for the full ~1M-item corpus (~18h). Greedy: a mid-
# harvest failure still ingests what was written (delete the cache to re-harvest).
LOC_BASE = "https://www.loc.gov/photos/"
LOC_UA = "harpe-ingest/1.0 (github.com/NullSense/harpe; matas234@gmail.com)"
LOC_PAGE_SIZE = 25
LOC_SLEEP = 3.0
LOC_SAMPLE_PAGES = 80   # pages per window (None = full corpus)
LOC_DATE_WINDOWS = ["1800/1899", "1900/1909", "1910/1919", "1920/1929", "1930/1939",
                    "1940/1949", "1950/1979", "1980/1999", "2000/2025", None]


def harvest_loc(sample_pages=LOC_SAMPLE_PAGES) -> str:
    dest = os.path.join(tempfile.gettempdir(), "harpe-loc.jsonl")
    if os.path.exists(dest):
        print(f"Reusing existing LOC harvest at {dest} (delete to re-harvest).")
        return dest
    print("Harvesting Library of Congress Prints & Photographs …")
    tmp = dest + ".tmp"
    total = 0

    def _fetch_page(sp, dates):
        url = f"{LOC_BASE}?fo=json&c={LOC_PAGE_SIZE}&sp={sp}&fa=access-restricted:false"
        if dates:
            url += f"&dates={dates}"
        req = urllib.request.Request(url, headers={"User-Agent": LOC_UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def _row(res):
        img = res.get("image_url", [])
        if not img:
            return None
        rid = res.get("id", "").rstrip("/").split("/")[-1]
        if not rid:
            return None
        item = res.get("item", {})
        creators = item.get("creators", [])
        artist = creators[0]["title"] if creators else (res.get("contributor", [None])[0])
        medium = (item.get("medium") or [None])[0]
        notes = item.get("notes", [])
        rights = (item.get("rights_information", "") or item.get("rights_advisory", "") or "")
        is_pd = bool(res.get("unrestricted") and "no known restriction" in rights.lower())
        return {
            "source": "loc", "id": f"loc-{rid}",
            "title": res.get("title") or "Untitled", "artist": artist,
            "date": item.get("created_published") or item.get("sort_date") or res.get("date"),
            "medium": medium, "dimensions": None,
            "culture": (res.get("subject") or [None])[0],
            "credit_line": item.get("call_number"),
            "description": " ".join(notes[:3]) if notes else None,
            "image_thumb": img[0].split("#")[0], "image_full": img[-1].split("#")[0],
            "width": None, "height": None,
            "source_url": res.get("url") or res.get("id", ""),
            "rights_type": (rights[:200] if rights else ("unrestricted" if res.get("unrestricted") else "unknown")),
            "is_public_domain": is_pd,
        }

    incomplete = None
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            for window in LOC_DATE_WINDOWS:
                if _ABORT.is_set():
                    raise KeyboardInterrupt
                label = window or "undated"
                sp, pages = 1, 0
                while True:
                    if _ABORT.is_set():
                        raise KeyboardInterrupt
                    data = _retry(f"LOC {label} sp={sp}", lambda sp=sp, w=window: _fetch_page(sp, w))
                    results = data.get("results", [])
                    if not results:
                        break
                    for res in results:
                        row = _row(res)
                        if row:
                            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                            total += 1
                    pages += 1
                    if sample_pages is not None and pages >= sample_pages:
                        break
                    if not data.get("pagination", {}).get("next"):
                        break
                    sp += 1
                    time.sleep(LOC_SLEEP)
                fh.flush()
                print(f"  LOC {label}: {total:,} rows so far")
                time.sleep(LOC_SLEEP)
    except KeyboardInterrupt:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    except (HarvestBlocked, Exception) as e:
        incomplete = str(e) or type(e).__name__
    if total == 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise HarvestBlocked(f"LOC: harvested 0 rows{f' ({incomplete})' if incomplete else ''}.")
    os.replace(tmp, dest)
    if incomplete:
        print(f"[loc] INCOMPLETE ({incomplete}) — ingesting {total:,} salvaged rows; "
              f"delete {dest} to re-harvest from scratch.")
    else:
        print(f"LOC harvest done: {total:,} rows → {dest}")
    return dest


def loc_sql(jsonl_path: str) -> str:
    p = jsonl_path.replace("'", "''")
    cols = ("{source:'VARCHAR',id:'VARCHAR',title:'VARCHAR',artist:'VARCHAR',date:'VARCHAR',"
            "medium:'VARCHAR',dimensions:'VARCHAR',culture:'VARCHAR',credit_line:'VARCHAR',"
            "description:'VARCHAR',image_thumb:'VARCHAR',image_full:'VARCHAR',width:'INTEGER',"
            "height:'INTEGER',source_url:'VARCHAR',rights_type:'VARCHAR',is_public_domain:'BOOLEAN'}")
    return (f"SELECT * FROM read_json('{p}', format='newline_delimited', columns={cols}) "
            "WHERE image_thumb IS NOT NULL AND image_full IS NOT NULL")


# ─── Harvard Art Museums (key-gated; full-res IIIF) ──────────────────────────
# Env: HARVARD_API_KEY (free, instant). ⚠ ToS is NON-COMMERCIAL + attribution —
# only ingest if your use qualifies. Image CDN (ids.lib.harvard.edu) hotlinks.
HARVARD_API_BASE = "https://api.harvardartmuseums.org/object"
HARVARD_FIELDS = ("id,title,people,dated,medium,dimensions,culture,creditline,"
                  "primaryimageurl,baseimageurl,url,imagepermissionlevel,accesslevel,copyright")


def harvest_harvard(max_pages: int = 2000) -> str:
    """Page the Harvard Art Museums API → JSONL (objects with a usable image).
    Full-res via IIIF baseimageurl. Key-gated; greedy salvage on failure."""
    key = os.environ.get("HARVARD_API_KEY", "").strip()
    if not key:
        raise HarvestBlocked("harvard: HARVARD_API_KEY not set (free at harvardartmuseums.org/collections/api).")
    dest = os.path.join(tempfile.gettempdir(), "harpe-harvard.jsonl")
    if os.path.exists(dest):
        print(f"Reusing existing Harvard harvest at {dest} (delete to re-harvest).")
        return dest
    print("Harvesting Harvard Art Museums …")
    tmp, total, page, incomplete = dest + ".tmp", 0, 1, None

    def _page(p):
        url = (f"{HARVARD_API_BASE}?apikey={key}&size=100&page={p}&hasimage=1&fields={HARVARD_FIELDS}")
        req = urllib.request.Request(url, headers={"User-Agent": "harpe-ingest/1.0 (non-commercial)"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def _row(o):
        if (o.get("imagepermissionlevel") or 0) >= 2 or (o.get("accesslevel") or 0) != 1:
            return None
        base = (o.get("baseimageurl") or "").strip()
        primary = (o.get("primaryimageurl") or "").strip()
        if not base and not primary:
            return None
        full = f"{base}/full/full/0/default.jpg" if base else primary
        thumb = f"{base}/full/!400,400/0/default.jpg" if base else primary
        artist = None
        for pp in (o.get("people") or []):
            if (pp.get("role") or "").lower() == "artist":
                artist = (pp.get("name") or "").strip() or None
                break
        if artist is None and o.get("people"):
            artist = (o["people"][0].get("name") or "").strip() or None
        cr = (o.get("copyright") or "").strip()
        return {
            "source": "harvard", "id": f"harvard-{o['id']}",
            "title": (o.get("title") or "").strip() or "Untitled", "artist": artist,
            "date": (o.get("dated") or "").strip() or None,
            "medium": (o.get("medium") or "").strip() or None,
            "dimensions": (o.get("dimensions") or "").strip() or None,
            "culture": (o.get("culture") or "").strip() or None,
            "credit_line": (o.get("creditline") or "").strip() or None,
            "description": None, "image_thumb": thumb, "image_full": full,
            "width": None, "height": None,
            "source_url": (o.get("url") or "").strip() or None,
            "rights_type": (cr[:200] if cr else None),
            "is_public_domain": "public domain" in cr.lower() if cr else False,
        }

    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            while True:
                if _ABORT.is_set():
                    raise KeyboardInterrupt
                data = _retry(f"Harvard page={page}", lambda p=page: _page(p))
                info = data.get("info") or {}
                for o in (data.get("records") or []):
                    row = _row(o)
                    if row:
                        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                        total += 1
                fh.flush()
                if page % 20 == 0:
                    print(f"  Harvard page {page} → {total:,} rows")
                if not info.get("next") or page >= max_pages:
                    break
                page += 1
                time.sleep(0.3)
    except KeyboardInterrupt:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    except (HarvestBlocked, Exception) as e:
        incomplete = str(e) or type(e).__name__
    if total == 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise HarvestBlocked(f"Harvard: 0 rows{f' ({incomplete})' if incomplete else ''}.")
    os.replace(tmp, dest)
    print(f"[harvard] {'INCOMPLETE (' + incomplete + ') — ' if incomplete else ''}{total:,} rows → {dest}")
    return dest


def harvard_sql(jsonl_path: str) -> str:
    p = jsonl_path.replace("'", "''")
    cols = ("{source:'VARCHAR',id:'VARCHAR',title:'VARCHAR',artist:'VARCHAR',date:'VARCHAR',"
            "medium:'VARCHAR',dimensions:'VARCHAR',culture:'VARCHAR',credit_line:'VARCHAR',"
            "description:'VARCHAR',image_thumb:'VARCHAR',image_full:'VARCHAR',width:'INTEGER',"
            "height:'INTEGER',source_url:'VARCHAR',rights_type:'VARCHAR',is_public_domain:'BOOLEAN'}")
    return (f"SELECT * FROM read_json('{p}', format='newline_delimited', columns={cols}) "
            "WHERE image_thumb IS NOT NULL AND image_full IS NOT NULL")


# ─── Europeana (key-gated; full-res where the provider allows) ────────────────
# Env: EUROPEANA_API_KEY (free; "apidemo" works for small runs). image_full =
# provider's edmIsShownBy (~90% hotlink), image_thumb = Europeana's own reliable
# thumbnail. reusability=open. NOTE: re-aggregates sources we already carry.
_EU_SEARCH = "https://api.europeana.eu/record/v2/search.json"


def harvest_europeana(max_rows: int | None = 500_000) -> str:
    """Cursor-page Europeana open IMAGE records → JSONL. Key-gated, resumable, greedy."""
    key = os.environ.get("EUROPEANA_API_KEY", "").strip() or "apidemo"
    out_path = os.path.join(tempfile.gettempdir(), "harpe-europeana.jsonl")
    state_path = out_path + ".state.json"
    if os.path.exists(out_path) and not os.path.exists(state_path):
        print(f"Reusing existing Europeana harvest at {out_path} (delete to re-harvest).")
        return out_path
    cursor, total = "*", 0
    if os.path.exists(state_path):
        try:
            st = json.load(open(state_path, encoding="utf-8"))
            cursor, total = st.get("cursor", "*"), st.get("total", 0)
            print(f"Resuming Europeana ({total:,} rows already).")
        except Exception:
            pass
    tmp = out_path + ".partial"
    incomplete = None

    def _page(cur):
        params = {"query": "*", "qf": "TYPE:IMAGE", "reusability": "open", "profile": "rich",
                  "rows": "100", "cursor": cur, "wskey": key}
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        req = urllib.request.Request(f"{_EU_SEARCH}?{qs}", headers={"User-Agent": "harpe-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def _row(it):
        rid = it.get("id", "")
        if not rid:
            return None
        full = (it.get("edmIsShownBy") or [None])[0]
        thumb = (it.get("edmPreview") or [None])[0]
        thumb = thumb or full
        if not thumb:
            return None
        rights = (it.get("rights") or [""])[0]
        is_pd = any(x in rights.lower() for x in ("publicdomain/zero", "publicdomain/mark"))

        def first(f):
            v = it.get(f)
            return (v[0] if isinstance(v, list) and v else (v or None)) if v else None
        return {
            "source": "europeana", "id": f"europeana-{rid.lstrip('/').replace('/', '-')}",
            "title": first("title"), "artist": first("dcCreator"),
            "date": first("year"), "medium": first("dcType"), "dimensions": None,
            "culture": first("edmCountry"), "credit_line": first("dataProvider"),
            "description": None, "image_thumb": thumb, "image_full": full or thumb,
            "width": None, "height": None, "source_url": first("edmIsShownAt"),
            "rights_type": rights or None, "is_public_domain": is_pd,
        }

    try:
        with open(tmp, "a" if os.path.exists(tmp) else "w", encoding="utf-8") as fh:
            while True:
                if _ABORT.is_set():
                    raise KeyboardInterrupt
                data = _retry(f"Europeana cursor={cursor[:24]}", lambda c=cursor: _page(c))
                if not data.get("success", True):
                    raise HarvestBlocked(f"Europeana refused: {data.get('error') or 'success=false'} "
                                         "(set EUROPEANA_API_KEY).")
                for it in (data.get("items") or []):
                    row = _row(it)
                    if row:
                        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                        total += 1
                fh.flush()
                nxt = data.get("nextCursor")
                json.dump({"cursor": nxt or cursor, "total": total}, open(state_path, "w", encoding="utf-8"))
                if total % 1000 == 0:
                    print(f"  Europeana: {total:,} rows")
                if (max_rows and total >= max_rows) or not nxt:
                    break
                cursor = nxt
                time.sleep(1.0)
    except KeyboardInterrupt:
        print(f"\n⏸  Europeana interrupted — {total:,} saved; re-run to resume.")
        raise
    except (HarvestBlocked, Exception) as e:
        incomplete = str(e) or type(e).__name__
    if total == 0:
        for f in (tmp, state_path):
            if os.path.exists(f):
                os.remove(f)
        raise HarvestBlocked(f"Europeana: 0 rows{f' ({incomplete})' if incomplete else ''}.")
    os.replace(tmp, out_path)
    if os.path.exists(state_path):
        os.remove(state_path)
    print(f"[europeana] {'INCOMPLETE (' + incomplete + ') — ' if incomplete else ''}{total:,} rows → {out_path}")
    return out_path


def europeana_sql(jsonl_path: str) -> str:
    p = jsonl_path.replace("'", "''")
    cols = ("{source:'VARCHAR',id:'VARCHAR',title:'VARCHAR',artist:'VARCHAR',date:'VARCHAR',"
            "medium:'VARCHAR',dimensions:'VARCHAR',culture:'VARCHAR',credit_line:'VARCHAR',"
            "description:'VARCHAR',image_thumb:'VARCHAR',image_full:'VARCHAR',width:'INTEGER',"
            "height:'INTEGER',source_url:'VARCHAR',rights_type:'VARCHAR',is_public_domain:'BOOLEAN'}")
    return f"SELECT * FROM read_json('{p}', format='newline_delimited', columns={cols})"


# ─── Source registry ─────────────────────────────────────────────────────────
# key → zero-arg callable returning that source's SELECT (running any harvest
# step first). MoMA/NGA are the always-on base; the rest are opt-in.
SOURCES = {
    "moma": lambda: MOMA_SQL,
    "nga": lambda: NGA_SQL,
    "mia": lambda: mia_sql(clone_mia()),
    "wellcome": lambda: WELLCOME_SQL,
    "aic": lambda: aic_sql(clone_aic()),
    "cleveland": lambda: CLEVELAND_SQL,
    "smk": lambda: smk_sql(harvest_smk()),
    "met": lambda: met_sql(harvest_met_dump()),
    "loc": lambda: loc_sql(harvest_loc()),
    "si": lambda: si_sql(os.path.join(download_si_art(), "*.txt")),
    "wikidata": lambda: wikidata_sql(harvest_wikidata()),
    "harvard": lambda: harvard_sql(harvest_harvard()),       # needs HARVARD_API_KEY (non-commercial ToS)
    "europeana": lambda: europeana_sql(harvest_europeana()),  # needs EUROPEANA_API_KEY
}
DEFAULT_SOURCES = list(SOURCES)   # default = every source

OUT = "harpe-art.parquet"


# Sources that draw their own tqdm bar — given dense, distinct screen rows so the
# concurrent bars don't overlap (other sources just print a ✓/⚠ line on finish).
_BAR_SOURCES = ("met", "si", "wikidata")


def _prepare_source_parquet(key: str, workdir: str, pos) -> tuple[str, str, int]:
    """Run one source end-to-end (harvest + DuckDB read) → its own parquet.

    Runs in its own thread with its own DuckDB connection, so every source pulls
    fully in parallel and a failure in one can't touch the others.
    """
    _tls.pos = pos
    sql = SOURCES[key]()                                  # network harvest/download happens here
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"SET temp_directory='{workdir}';")      # spill to the run dir, not the repo
    con.execute("SET preserve_insertion_order=false;")   # let DuckDB parallelize the scan
    out = os.path.join(workdir, f"{key}.parquet")
    con.execute(f"COPY ({sql}) TO '{out}' (FORMAT parquet, COMPRESSION zstd);")
    cnt = con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]
    con.close()
    if cnt == 0:
        os.remove(out)
        raise HarvestBlocked(f"{key}: produced 0 rows")
    return key, out, cnt


def build_parquet(path: str, keys: list[str], jobs: int | None = None) -> set[str]:
    for k in keys:
        if k not in SOURCES:
            raise SystemExit(f"Unknown source '{k}'. Known: {', '.join(SOURCES)}")

    workdir = tempfile.mkdtemp(prefix="harpe-build-")
    jobs = jobs or len(keys)                              # default: pull every source at once
    # Assign dense bar rows to the bar-drawing sources that are actually in this run.
    bar_keys = [k for k in keys if k in _BAR_SOURCES]
    pos_of = {k: i for i, k in enumerate(bar_keys)}
    print(f"Pulling {len(keys)} sources with up to {jobs} in parallel: {', '.join(keys)} …")

    made, skipped = [], []
    pool = ThreadPoolExecutor(max_workers=jobs)
    futs = {pool.submit(_prepare_source_parquet, k, workdir, pos_of.get(k)): k for k in keys}
    try:
        for fut in as_completed(futs):
            k = futs[fut]
            try:
                key, out, cnt = fut.result()
                made.append((key, out))
                tqdm.write(f"  ✓ {key}: {cnt:,} rows")
            except HarvestBlocked as e:
                tqdm.write(f"  ⚠ skipping '{k}': {e}")
                skipped.append(k)
            except Exception as e:  # one bad source must not sink the whole build
                tqdm.write(f"  ⚠ skipping '{k}': {type(e).__name__}: {e}")
                skipped.append(k)
    except KeyboardInterrupt:
        _ABORT.set()                                     # tell in-flight harvests to stop
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown(wait=True)

    if not made:
        shutil.rmtree(workdir, ignore_errors=True)
        raise SystemExit("No sources succeeded — nothing to write.")

    # Combine the per-source parquets locally (fast, no network) → atomic final write.
    con = duckdb.connect()
    con.execute(f"SET temp_directory='{workdir}';")
    con.execute("SET preserve_insertion_order=false;")
    paths = "[" + ", ".join("'" + p.replace("'", "''") + "'" for _, p in made) + "]"
    tmp_out = path + ".tmp"
    con.execute(f"COPY (SELECT * FROM read_parquet({paths}, union_by_name=true)) "
                f"TO '{tmp_out}' (FORMAT parquet, COMPRESSION zstd);")
    os.replace(tmp_out, path)

    n = con.execute(f"SELECT count(*) FROM '{path}'").fetchone()[0]
    by_src = con.execute(f"SELECT source, count(*) FROM '{path}' GROUP BY source ORDER BY 2 DESC").fetchall()
    con.close()
    shutil.rmtree(workdir, ignore_errors=True)
    print(f"\nBuilt {path}: {n:,} rows from {len(made)} source(s)  {dict(by_src)}")
    if skipped:
        print(f"Skipped {len(skipped)} this run: {', '.join(skipped)} "
              "(publishing keeps any copy already on Hugging Face — nothing is lost).")
    return {k for k, _ in made}


def publish(path: str, built_keys: set[str], repo: str) -> None:
    """Publish to the HF dataset, MERGING with what's already there.

    Sources built this run replace their published rows; sources NOT built this
    run are carried over from the existing dataset. So no command — not even a
    single-source build — can ever shrink the published dataset. Backfilling is
    just `--sources <key> --push`; it adds to what's live.

    Transfers ride hf_xet (the Hub's default accelerated, chunk-deduped transport —
    hf_transfer/HF_HUB_ENABLE_HF_TRANSFER is deprecated and ignored). We opt into
    its high-performance mode so the upload/merge-download saturate the link.
    """
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    from huggingface_hub import HfApi, hf_hub_download

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"SET temp_directory='{tempfile.gettempdir()}';")
    con.execute("SET preserve_insertion_order=false;")
    parts = [f"SELECT * FROM read_parquet('{path.replace(chr(39), chr(39) * 2)}')"]
    try:
        existing = hf_hub_download(repo_id=repo, repo_type="dataset", filename="data/train.parquet")
        keep = "(" + ", ".join("'" + k + "'" for k in sorted(built_keys)) + ")"
        parts.append(f"SELECT * FROM read_parquet('{existing}') WHERE source NOT IN {keep}")
        print(f"Merging with existing dataset (replacing {len(built_keys)} rebuilt source(s), "
              "keeping the rest)…")
    except Exception:
        print("No existing dataset found — publishing fresh.")

    merged = path + ".publish.parquet"
    con.execute(f"COPY ({' UNION ALL BY NAME '.join(parts)}) "
                f"TO '{merged}' (FORMAT parquet, COMPRESSION zstd);")
    mq = merged.replace(chr(39), chr(39) * 2)
    by_src = con.execute(f"SELECT source, count(*) FROM read_parquet('{mq}') "
                         "GROUP BY source ORDER BY 2 DESC").fetchall()
    total = sum(c for _, c in by_src)
    con.close()

    api = HfApi()
    api.create_repo(repo, repo_type="dataset", exist_ok=True)
    api.upload_file(path_or_fileobj=merged, path_in_repo="data/train.parquet",
                    repo_id=repo, repo_type="dataset")
    os.remove(merged)
    print(f"\nPublished {total:,} rows across {len(by_src)} sources → "
          f"https://huggingface.co/datasets/{repo}\n  {dict(by_src)}")
    print("HARPE_DUMP_DATASET is wired via Infisical→Vercel — redeploy to serve the new rows.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    # Silence chatty third-party request loggers — they flood the progress bars
    # with one "HTTP Request: GET … 200 OK" line per file/page.
    for noisy in ("httpx", "httpcore", "urllib3", "huggingface_hub", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    ap = argparse.ArgumentParser(
        description="Pull open-data museum dumps into one Parquet and (optionally) publish to Hugging Face. "
                    "Default builds EVERY source in parallel; publishing always merges (never shrinks the dataset).")
    ap.add_argument("--push", metavar="HF_DATASET", nargs="?", const="NullSense/harpe-art", default=None,
                    help="publish to this HF dataset (default NullSense/harpe-art when given without a value); "
                         "so `--push --enrich` works")
    ap.add_argument("--sources", help="comma-separated subset to (re)build instead of all; "
                                      f"available: {', '.join(SOURCES)}")
    ap.add_argument("--jobs", type=int, default=None,
                    help="max sources to pull in parallel (default: all at once)")
    ap.add_argument("--out", default=OUT, help=f"local output parquet (default: {OUT})")
    ap.add_argument("--enrich", action="store_true",
                    help="after publishing, build + push the knowledge-graph entity layer "
                         "(artist/depicts via a separate WDQS pass); requires --push")
    ap.add_argument("--enrich-only", action="store_true",
                    help="skip harvesting — only (re)build the entity layer from the already-"
                         "published dataset; requires --push")
    args = ap.parse_args()

    keys = ([k.strip() for k in args.sources.split(",") if k.strip()]
            if args.sources else list(DEFAULT_SOURCES))

    try:
        if args.enrich_only:
            if not args.push:
                ap.error("--enrich-only requires --push <HF_DATASET>")
            import enrich_entities
            enrich_entities.enrich(args.push)
        else:
            built = build_parquet(args.out, keys, jobs=args.jobs)
            if args.push:
                publish(args.out, built, args.push)
                if args.enrich:
                    import enrich_entities
                    enrich_entities.enrich(args.push)
        if args.enrich and not args.push:
            print("Note: --enrich does nothing without --push (it patches the published dataset).")
    except KeyboardInterrupt:
        print("\nAborted. Harvest progress is cached (Met resumes; others rebuild fast) — just re-run.")
        raise SystemExit(130)
