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
  source, id, title, artist, date, medium, credit_line, description,
  image_thumb, image_full, source_url, is_public_domain

Run:
  uv run scripts/ingest-art-dumps/ingest.py                 # build harpe-art.parquet
  uv run scripts/ingest-art-dumps/ingest.py --push <hf-user>/harpe-art   # + upload
                                                            #   (needs `huggingface-cli login`)

Add more museums by writing another SELECT that yields the same columns and
UNION-ing it in build_parquet().
"""
import argparse
import duckdb

# Raw dump locations (MoMA's JSON is Git-LFS → use the media. host, not raw.).
MOMA_JSON = "https://media.githubusercontent.com/media/MuseumofModernArt/collection/main/Artworks.json"
NGA_OBJECTS = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/objects.csv"
NGA_IMAGES = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/published_images.csv"

# MoMA: Artist is an array; flatten to a comma-joined string. Keep only rows with
# a usable image (ImageURL is null for in-copyright works).
MOMA_SQL = f"""
SELECT
  'moma' AS source,
  'moma-' || CAST("ObjectID" AS VARCHAR) AS id,
  COALESCE("Title", 'Untitled') AS title,
  array_to_string("Artist", ', ') AS artist,
  "Date" AS date,
  "Medium" AS medium,
  "CreditLine" AS credit_line,
  NULL AS description,
  "ThumbnailURL" AS image_thumb,
  "ImageURL" AS image_full,
  "URL" AS source_url,
  TRUE AS is_public_domain
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
  o.creditline AS credit_line,
  NULL AS description,
  pi.iiifthumburl AS image_thumb,
  pi.iiifurl || '/full/full/0/default.jpg' AS image_full,
  'https://www.nga.gov/collection/art-object-page.' || CAST(o.objectid AS VARCHAR) || '.html' AS source_url,
  TRUE AS is_public_domain
FROM read_csv_auto('{NGA_OBJECTS}', ignore_errors=true) o
JOIN read_csv_auto('{NGA_IMAGES}', ignore_errors=true) pi
  ON pi.depictstmsobjectid = o.objectid
WHERE pi.openaccess = 1 AND pi.viewtype = 'primary'
"""

# MIA (Minneapolis Institute of Art): the artsmia/collection repo is SHARDED JSON
# (one file per object), so there's no single dump to read_json. Two options:
#   1. clone the repo and read_json_auto over the object/**/*.json glob, or
#   2. use their search API.
# Left as a follow-up; MoMA + NGA prove the pattern end-to-end first.

OUT = "harpe-art.parquet"


def build_parquet(path: str) -> None:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    print("Building combined dataset (downloading dumps — MoMA is ~145 MB)…")
    con.execute(f"""
        COPY (
          {MOMA_SQL}
          UNION ALL BY NAME
          {NGA_SQL}
        ) TO '{path}' (FORMAT parquet, COMPRESSION zstd);
    """)
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
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    build_parquet(args.out)
    if args.push:
        push(args.out, args.push)
