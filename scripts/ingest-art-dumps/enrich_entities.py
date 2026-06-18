# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb>=1.1", "huggingface_hub[hf_xet]>=0.34", "httpx>=0.27", "tqdm>=4.66", "tenacity>=8.5"]
# ///
"""
Knowledge-graph entity enrichment for the Harpe art dataset (Phase 1, steps 2-4 of
notes/ART-KG-ARCHITECTURE.md). Runs AFTER the main ingest (ingest.py) has published
`data/train.parquet` carrying the `wikidata_qid` spine column.

It does NOT harvest artworks. It:
  1. reads the distinct Wikidata QIDs already in the published works,
  2. one separate WDQS pass (VALUES batches of 50) for P170 creator / P180 depicts
     / P195 collection / P135 movement — aggregated per work (NO row explosion, no
     change to the harvest query),
  3. patches the works Parquet with artist_qid / depicts_qids (space-joined) /
     collection_qid / movement columns and re-pushes it,
  4. builds + pushes the static entity files the runtime reads by plain CDN GET:
       data/artists/<QID>.json, data/work_ids_by_artist/<QID>.json,
       data/depicts/<QID>.json, data/name_to_qid.json
     (the HF /filter WHERE API is broken → static files, no query engine).

Offline image clustering (cluster_id) is intentionally NOT done here.

Usage:
  infisical run --env dev --path /Harpe -- \
    uv run scripts/ingest-art-dumps/enrich_entities.py --repo NullSense/harpe-art

Resumable: the artwork entity pass checkpoints to /tmp/harpe-entities.json, so a
crash / Ctrl-C / WDQS meltdown re-runs from where it stopped.
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import unicodedata
from collections import defaultdict

import duckdb
import httpx
import tenacity
from tqdm import tqdm

_WDQS = "https://query.wikidata.org/sparql"
_UA = "HarpeArtIngest/1.0 (github.com/NullSense/harpe; matas234@gmail.com)"
_BATCH = 50          # QIDs per VALUES block (keeps OPTIONAL cross-products small)
_SUBJECT_CAP = 4000  # build depicts entity files only for the most-used subjects
_CKPT = os.path.join(tempfile.gettempdir(), "harpe-entities.json")

# ── WDQS query templates (VALUES-driven; aggregated in Python) ────────────────
_Q_WORKS = """\
SELECT ?item ?creator ?depicts ?collection ?movement ?movementLabel WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wdt:P170 ?creator . }}
  OPTIONAL {{ ?item wdt:P180 ?depicts . }}
  OPTIONAL {{ ?item wdt:P195 ?collection . }}
  OPTIONAL {{ ?item wdt:P135 ?movement . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" . }}
}}
"""
_Q_ARTISTS = """\
SELECT ?a ?aLabel ?aDescription ?birth ?death ?nat ?natLabel ?ulan ?img ?alias
       ?movement ?movementLabel WHERE {{
  VALUES ?a {{ {values} }}
  OPTIONAL {{ ?a wdt:P569 ?birth . }}
  OPTIONAL {{ ?a wdt:P570 ?death . }}
  OPTIONAL {{ ?a wdt:P27 ?nat . }}
  OPTIONAL {{ ?a wdt:P245 ?ulan . }}
  OPTIONAL {{ ?a wdt:P18 ?img . }}
  OPTIONAL {{ ?a skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }}
  OPTIONAL {{ ?a wdt:P135 ?movement . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" . }}
}}
"""
_Q_SUBJECTS = """\
SELECT ?s ?sLabel ?sDescription ?img WHERE {{
  VALUES ?s {{ {values} }}
  OPTIONAL {{ ?s wdt:P18 ?img . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" . }}
}}
"""


class _Retryable(Exception):
    pass


@tenacity.retry(
    retry=tenacity.retry_if_exception_type(_Retryable),
    stop=tenacity.stop_after_attempt(6),
    wait=tenacity.wait_exponential(multiplier=3, max=60) + tenacity.wait_random(0, 2),
    reraise=True,
)
def _wd_query(client: httpx.Client, query: str) -> list[dict]:
    try:
        resp = client.get(
            _WDQS, params={"query": query},
            headers={"Accept": "application/sparql-results+json", "User-Agent": _UA},
            timeout=90,
        )
    except (httpx.TransportError, httpx.TimeoutException, OSError) as e:
        raise _Retryable(str(e)) from e
    if resp.status_code == 429 or resp.status_code >= 500:
        raise _Retryable(f"HTTP {resp.status_code}")
    resp.raise_for_status()
    try:
        return json.loads(resp.text, strict=False)["results"]["bindings"]
    except json.JSONDecodeError as e:
        raise _Retryable(f"truncated body: {e}") from e


def _qid(uri: str) -> str:
    """'http://www.wikidata.org/entity/Q42' → 'Q42' (already-bare passes through)."""
    return uri.rsplit("/", 1)[-1]


def _val(b: dict, key: str) -> str | None:
    v = b.get(key)
    return v.get("value") if v else None


def _batches(items: list[str], n: int):
    for i in range(0, len(items), n):
        yield items[i:i + n]


# ── normalize() — must mirror packages/core/src/search.ts normalize() ─────────
_FOLD = {"æ": "ae", "ø": "o", "å": "a", "œ": "oe", "ß": "ss", "ð": "d", "þ": "th"}


def normalize(s: str) -> str:
    s = (s or "").lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # strip accents
    s = "".join(_FOLD.get(c, c) for c in s)
    s = "".join(c if (c.isalnum() or c.isspace()) else " " for c in s)
    return " ".join(s.split())


def _is_latin(s: str) -> bool:
    return all(ord(c) < 0x250 or c.isspace() for c in s)


def suffix_variants(label_norm: str) -> list[str]:
    """'vincent van gogh' → ['van gogh', 'gogh'] (each ≥ 4 chars)."""
    w = label_norm.split()
    out = []
    for i in range(1, len(w)):
        s = " ".join(w[i:])
        if len(s) >= 4:
            out.append(s)
    return out


# ── Step 2: artwork → creator/depicts/collection/movement ─────────────────────
def harvest_work_entities(client: httpx.Client, qids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if os.path.exists(_CKPT):
        try:
            out = json.load(open(_CKPT))
            print(f"  resuming: {len(out):,} works already enriched")
        except Exception:
            out = {}
    todo = [q for q in qids if q not in out]
    for batch in tqdm(list(_batches(todo, _BATCH)), desc="works", unit="batch"):
        values = " ".join(f"wd:{q}" for q in batch)
        agg: dict[str, dict] = {q: {"creators": set(), "depicts": set(),
                                    "collection": None, "movement": None} for q in batch}
        try:
            for b in _wd_query(client, _Q_WORKS.format(values=values)):
                q = _qid(_val(b, "item") or "")
                if q not in agg:
                    continue
                if (c := _val(b, "creator")):
                    agg[q]["creators"].add(_qid(c))
                if (d := _val(b, "depicts")):
                    agg[q]["depicts"].add(_qid(d))
                if (col := _val(b, "collection")) and not agg[q]["collection"]:
                    agg[q]["collection"] = _qid(col)
                if (m := _val(b, "movementLabel")) and not agg[q]["movement"]:
                    agg[q]["movement"] = m
        except Exception as e:  # greedy: keep what we have, skip this window
            print(f"  works batch failed ({e}); skipping {len(batch)} qids")
        for q, a in agg.items():
            out[q] = {
                "artist_qid": sorted(a["creators"])[0] if a["creators"] else None,
                "depicts_qids": " ".join(sorted(a["depicts"])) or None,
                "collection_qid": a["collection"],
                "movement": a["movement"],
            }
        json.dump(out, open(_CKPT, "w"))  # checkpoint after every batch
    return out


# ── Step 4a: artist metadata ──────────────────────────────────────────────────
def harvest_artists(client: httpx.Client, qids: list[str], work_counts: dict[str, int]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for batch in tqdm(list(_batches(qids, _BATCH)), desc="artists", unit="batch"):
        values = " ".join(f"wd:{q}" for q in batch)
        try:
            rows = _wd_query(client, _Q_ARTISTS.format(values=values))
        except Exception as e:
            print(f"  artists batch failed ({e}); skipping {len(batch)}")
            continue
        for b in rows:
            q = _qid(_val(b, "a") or "")
            if not q:
                continue
            e = out.setdefault(q, {
                "qid": q, "labelEn": None, "description": None, "aliases": set(),
                "birthYear": None, "deathYear": None, "nationality": None,
                "movementLabels": set(), "ulanId": None, "imageCommons": None,
                "workCount": work_counts.get(q, 0),
            })
            e["labelEn"] = e["labelEn"] or _val(b, "aLabel")
            e["description"] = e["description"] or _val(b, "aDescription")
            if (al := _val(b, "alias")):
                e["aliases"].add(al)
            for fld, key in (("birthYear", "birth"), ("deathYear", "death")):
                if e[fld] is None and (v := _val(b, key)):
                    try:
                        e[fld] = int(v[:4]) if v[0] != "-" else -int(v[1:5])
                    except (ValueError, IndexError):
                        pass
            e["nationality"] = e["nationality"] or _val(b, "natLabel")
            e["ulanId"] = e["ulanId"] or _val(b, "ulan")
            if (img := _val(b, "img")):
                e["imageCommons"] = e["imageCommons"] or _qid(img)  # Commons filename
            if (mv := _val(b, "movementLabel")):
                e["movementLabels"].add(mv)
    # finalize sets → lists, drop empties
    for e in out.values():
        e["aliases"] = sorted(a for a in e["aliases"] if a and a != e["labelEn"])
        e["movementLabels"] = sorted(e["movementLabels"])
    return out


# ── Step 4b: subject ("depicts") metadata ─────────────────────────────────────
def harvest_subjects(client: httpx.Client, qids: list[str], counts: dict[str, int]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for batch in tqdm(list(_batches(qids, _BATCH)), desc="subjects", unit="batch"):
        values = " ".join(f"wd:{q}" for q in batch)
        try:
            rows = _wd_query(client, _Q_SUBJECTS.format(values=values))
        except Exception as e:
            print(f"  subjects batch failed ({e}); skipping {len(batch)}")
            continue
        for b in rows:
            q = _qid(_val(b, "s") or "")
            if not q:
                continue
            img = _val(b, "img")
            out[q] = {
                "qid": q, "labelEn": _val(b, "sLabel") or q,
                "description": _val(b, "sDescription"),
                "imageCommons": _qid(img) if img else None,
                "workCount": counts.get(q, 0),
            }
    return out


def _clean(d: dict) -> dict:
    """Drop None/empty values so the static JSON stays small."""
    return {k: v for k, v in d.items() if v not in (None, "", [], set())}


def build_name_to_qid(artists: dict[str, dict]) -> dict[str, str]:
    """alias/label → QID, normalize()-keyed. Suffix variants ('gogh') included with
    a collision guard; non-Latin labels also stored raw under a 'raw:' prefix."""
    direct: dict[str, str] = {}
    suffix_hits: dict[str, set] = defaultdict(set)
    for q, e in artists.items():
        names = [e.get("labelEn")] + list(e.get("aliases") or [])
        for nm in filter(None, names):
            norm = normalize(nm)
            if norm:
                direct.setdefault(norm, q)
            if not _is_latin(nm):
                direct.setdefault(f"raw:{nm}", q)
            if e.get("labelEn"):
                for sfx in suffix_variants(normalize(e["labelEn"])):
                    suffix_hits[sfx].add(q)
    # add only non-colliding suffixes (a suffix mapping to >1 artist is dropped)
    for sfx, qs in suffix_hits.items():
        if len(qs) == 1 and sfx not in direct:
            direct[sfx] = next(iter(qs))
    return direct


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the Harpe knowledge-graph entity layer from the published works.")
    ap.add_argument("--repo", default="NullSense/harpe-art", help="HF dataset repo")
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "harpe-train-enriched.parquet"))
    args = ap.parse_args()

    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    from huggingface_hub import HfApi, hf_hub_download
    from huggingface_hub import CommitOperationAdd

    print("Downloading published works…")
    train = hf_hub_download(repo_id=args.repo, repo_type="dataset", filename="data/train.parquet")

    con = duckdb.connect()
    con.execute(f"SET temp_directory='{tempfile.gettempdir()}';")
    tq = train.replace("'", "''")
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{tq}')").fetchall()]
    if "wikidata_qid" not in cols:
        raise SystemExit("train.parquet has no wikidata_qid column — run the updated ingest.py first.")
    work_qids = [r[0] for r in con.execute(
        f"SELECT DISTINCT wikidata_qid FROM read_parquet('{tq}') WHERE wikidata_qid IS NOT NULL"
    ).fetchall()]
    print(f"{len(work_qids):,} distinct Wikidata works to enrich")

    client = httpx.Client(follow_redirects=True)

    # Step 2 — work → creator/depicts/collection/movement
    work_ent = harvest_work_entities(client, work_qids)

    # roll up: artist work-ids, artist work-counts, subject frequencies
    work_ids_by_artist: dict[str, list[str]] = defaultdict(list)
    artist_counts: dict[str, int] = defaultdict(int)
    subject_counts: dict[str, int] = defaultdict(int)
    for q, e in work_ent.items():
        if e.get("artist_qid"):
            work_ids_by_artist[e["artist_qid"]].append(f"wd-{q}")
            artist_counts[e["artist_qid"]] += 1
        for d in (e.get("depicts_qids") or "").split():
            subject_counts[d] += 1

    # Step 4 — artist + subject metadata (subjects capped to the most-used)
    artist_qids = sorted(artist_counts)
    print(f"{len(artist_qids):,} distinct artists")
    artists = harvest_artists(client, artist_qids, artist_counts)

    top_subjects = sorted(subject_counts, key=lambda s: -subject_counts[s])[:_SUBJECT_CAP]
    print(f"{len(top_subjects):,} subjects (capped at {_SUBJECT_CAP:,})")
    subjects = harvest_subjects(client, top_subjects, subject_counts)
    client.close()

    # Step 3 — patch the works Parquet with the 4 KG columns, then re-publish
    print("Patching works Parquet…")
    rows = [(q, e.get("artist_qid"), e.get("depicts_qids"), e.get("collection_qid"), e.get("movement"))
            for q, e in work_ent.items()]
    con.execute("CREATE TABLE enr (wikidata_qid VARCHAR, artist_qid VARCHAR, depicts_qids VARCHAR, "
                "collection_qid VARCHAR, movement VARCHAR)")
    con.executemany("INSERT INTO enr VALUES (?,?,?,?,?)", rows)
    enr_cols = ["artist_qid", "depicts_qids", "collection_qid", "movement"]
    present = [c for c in enr_cols if c in cols]
    excl = f"EXCLUDE ({', '.join(present)})" if present else ""
    oq = args.out.replace("'", "''")
    con.execute(
        f"COPY (SELECT w.* {excl}, e.artist_qid, e.depicts_qids, e.collection_qid, e.movement "
        f"FROM read_parquet('{tq}') w LEFT JOIN enr e USING (wikidata_qid)) "
        f"TO '{oq}' (FORMAT parquet, COMPRESSION zstd)"
    )
    con.close()

    api = HfApi()
    print("Uploading patched works Parquet…")
    api.upload_file(path_or_fileobj=args.out, path_in_repo="data/train.parquet",
                    repo_id=args.repo, repo_type="dataset")

    # name_to_qid.json → published to the HF CDN as part of the entity layer (a
    # future runtime singleton can resolve non-Wikidata artist names to QIDs from
    # it; Wikidata works already carry artist_qid directly). Never written to source.
    name_to_qid = build_name_to_qid(artists)
    print(f"{len(name_to_qid):,} name→QID entries")

    # Static entity files → one HF commit (batched CommitOperationAdd)
    print("Building + pushing static entity files…")
    ops = [CommitOperationAdd(
        path_in_repo="data/name_to_qid.json",
        path_or_fileobj=json.dumps(name_to_qid, ensure_ascii=False, separators=(",", ":")).encode(),
    )]
    for q, e in artists.items():
        ops.append(CommitOperationAdd(
            path_in_repo=f"data/artists/{q}.json",
            path_or_fileobj=json.dumps(_clean(e), ensure_ascii=False).encode()))
        ops.append(CommitOperationAdd(
            path_in_repo=f"data/work_ids_by_artist/{q}.json",
            path_or_fileobj=json.dumps(work_ids_by_artist.get(q, [])).encode()))
    for q, e in subjects.items():
        ops.append(CommitOperationAdd(
            path_in_repo=f"data/depicts/{q}.json",
            path_or_fileobj=json.dumps(_clean(e), ensure_ascii=False).encode()))

    # HF caps operations per commit; chunk to be safe.
    CHUNK = 256
    for i in tqdm(range(0, len(ops), CHUNK), desc="commit", unit="chunk"):
        api.create_commit(repo_id=args.repo, repo_type="dataset", operations=ops[i:i + CHUNK],
                          commit_message=f"entity files {i // CHUNK + 1}")

    print(f"\nDone. {len(artists):,} artists, {len(subjects):,} subjects, "
          f"{sum(len(v) for v in work_ids_by_artist.values()):,} artist↔work links.")
    print("Patched works + entity files are live on the HF CDN — redeploy Vercel to serve them.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted — the works entity pass is checkpointed; re-run to resume.")
        raise SystemExit(130)
