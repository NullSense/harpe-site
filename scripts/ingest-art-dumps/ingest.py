# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.1", "huggingface_hub>=0.25"]
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

Run:
  uv run scripts/ingest-art-dumps/ingest.py                 # build harpe-art.parquet (MoMA + NGA)
  uv run scripts/ingest-art-dumps/ingest.py --with-mia      # + Minneapolis Institute of Art
  uv run scripts/ingest-art-dumps/ingest.py --with-mia --push <hf-user>/harpe-art   # + upload
                                                            #   (needs `huggingface-cli login`)

Add more museums by writing another SELECT that yields the same columns and
UNION-ing it in build_parquet().
"""
import argparse
import os
import subprocess
import tempfile

import duckdb

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


def clone_mia() -> str:
    """Shallow blob-filtered clone of the MIA collection into a temp dir; returns it."""
    dest = os.path.join(tempfile.gettempdir(), "harpe-mia-collection")
    if os.path.isdir(os.path.join(dest, "objects")):
        print(f"Reusing existing MIA clone at {dest} (delete it to re-pull).")
        return dest
    print(f"Cloning MIA collection (shallow, blob-filtered) → {dest} …")
    subprocess.run(
        ["git", "clone", "--depth", "1", "--filter=blob:none",
         "--sparse", MIA_REPO, dest],
        check=True,
    )
    # Sparse-checkout only the objects/ tree (the per-object JSON we actually read).
    subprocess.run(["git", "-C", dest, "sparse-checkout", "set", "objects"], check=True)
    return dest


OUT = "harpe-art.parquet"


def build_parquet(path: str, with_mia: bool = False) -> None:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    print("Building combined dataset (downloading dumps — MoMA is ~145 MB)…")
    selects = [MOMA_SQL, NGA_SQL]
    if with_mia:
        selects.append(mia_sql(clone_mia()))
    combined = "\n          UNION ALL BY NAME\n          ".join(f"({s})" for s in selects)
    con.execute(f"COPY ({combined}) TO '{path}' (FORMAT parquet, COMPRESSION zstd);")
    n = con.execute(f"SELECT count(*) FROM '{path}'").fetchone()[0]
    by_src = con.execute(f"SELECT source, count(*) FROM '{path}' GROUP BY source").fetchall()
    print(f"Wrote {path}: {n:,} rows  {dict(by_src)}")


def push(path: str, repo: str) -> None:
    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(repo, repo_type="dataset", exist_ok=True)
    # Put the file under data/ so HF auto-converts it to the queryable Parquet branch.
    api.upload_file(path_or_fileobj=path, path_in_repo="data/train.parquet",
                    repo_id=repo, repo_type="dataset")
    print(f"Pushed to https://huggingface.co/datasets/{repo}")
    print(f"Set HARPE_DUMP_DATASET={repo} in Vercel, then redeploy.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--push", metavar="HF_DATASET", help="e.g. NullSense/harpe-art")
    ap.add_argument("--with-mia", action="store_true",
                    help="also ingest Minneapolis Institute of Art (shallow-clones artsmia/collection)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    build_parquet(args.out, with_mia=args.with_mia)
    if args.push:
        push(args.out, args.push)
