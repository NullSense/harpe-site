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
import re
import tempfile
import urllib.parse
from collections import defaultdict

import duckdb
import httpx
import tenacity
from tqdm import tqdm

# QLever: a SPARQL engine over the full Wikidata dump with no 60s timeout — the
# same endpoint the harvest uses. Far faster than WDQS for this VALUES-driven pass,
# and it lets us use big batches. It needs explicit PREFIXes and rdfs:label /
# schema:description joins (no WDQS `SERVICE wikibase:label`). Results aggregated in
# Python.
_WDQS = "https://qlever.cs.uni-freiburg.de/api/wikidata"
_UA = "HarpeArtIngest/1.0 (github.com/NullSense/harpe; matas234@gmail.com)"
_BATCH = 1000        # QIDs per VALUES block — QLever handles big blocks fast
_SUBJECT_CAP = 4000  # build depicts entity files only for the most-used subjects
_CKPT = os.path.join(tempfile.gettempdir(), "harpe-entities.json")
# Entity files are SHARDED into bucket bundles ({QID: entity} per file) because HF
# caps any directory at 10,000 files — one-file-per-QID (~90k artists) blows past it.
# bucket = int(QID-digits) % _SHARDS. The runtime (adapters.ts `entityBucket`) MUST
# use the identical scheme; both are covered by parity tests. 256 → ~350 artists per
# ~100 KB bundle, 256 files/dir (well under the cap), ~769 files total (was ~184k).
_SHARDS = 256
# Built artists+subjects are checkpointed here BEFORE the push, so a failed/slow HF
# commit never forces a re-harvest of the ~16 min artist pass — re-run resumes here.
_ENT_CKPT = os.path.join(tempfile.gettempdir(), "harpe-entities-built.json")


def _bucket(qid: str) -> int:
    """Shard key for an entity QID — MUST match adapters.ts `entityBucket`."""
    return int(qid[1:]) % _SHARDS

_PREFIX = (
    "PREFIX wdt: <http://www.wikidata.org/prop/direct/> "
    "PREFIX wd: <http://www.wikidata.org/entity/> "
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> "
    "PREFIX skos: <http://www.w3.org/2004/02/skos/core#> "
    "PREFIX schema: <http://schema.org/> "
    "PREFIX wikibase: <http://wikiba.se/ontology#> "
)
# ?nb = Wikidata sitelink count — the notability/fame prior. Patched onto the works
# Parquet as nb_sitelinks so search can ORDER BY it (famous works first) and the
# runtime ranker can boost iconic works. Validated on QLever (Mona Lisa=146).
_Q_WORKS = _PREFIX + """SELECT ?item ?creator ?depicts ?depictsLabel ?collection ?movementLabel ?nb WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wdt:P170 ?creator . }}
  OPTIONAL {{ ?item wdt:P180 ?depicts . OPTIONAL {{ ?depicts rdfs:label ?depictsLabel . FILTER(LANG(?depictsLabel) = "en") }} }}
  OPTIONAL {{ ?item wdt:P195 ?collection . }}
  OPTIONAL {{ ?item wdt:P135 ?movement . OPTIONAL {{ ?movement rdfs:label ?movementLabel . FILTER(LANG(?movementLabel) = "en") }} }}
  OPTIONAL {{ ?item wikibase:sitelinks ?nb . }}
}}
"""
_Q_ARTISTS = _PREFIX + """SELECT ?a ?aLabel ?aDescription ?birth ?death ?natLabel ?ulan ?img ?alias ?movementLabel WHERE {{
  VALUES ?a {{ {values} }}
  OPTIONAL {{ ?a rdfs:label ?aLabel . FILTER(LANG(?aLabel) = "en") }}
  OPTIONAL {{ ?a schema:description ?aDescription . FILTER(LANG(?aDescription) = "en") }}
  OPTIONAL {{ ?a wdt:P569 ?birth . }}
  OPTIONAL {{ ?a wdt:P570 ?death . }}
  OPTIONAL {{ ?a wdt:P27 ?nat . OPTIONAL {{ ?nat rdfs:label ?natLabel . FILTER(LANG(?natLabel) = "en") }} }}
  OPTIONAL {{ ?a wdt:P245 ?ulan . }}
  OPTIONAL {{ ?a wdt:P18 ?img . }}
  OPTIONAL {{ ?a skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }}
  OPTIONAL {{ ?a wdt:P135 ?movement . OPTIONAL {{ ?movement rdfs:label ?movementLabel . FILTER(LANG(?movementLabel) = "en") }} }}
}}
"""
_Q_SUBJECTS = _PREFIX + """SELECT ?s ?sLabel ?sDescription ?img WHERE {{
  VALUES ?s {{ {values} }}
  OPTIONAL {{ ?s rdfs:label ?sLabel . FILTER(LANG(?sLabel) = "en") }}
  OPTIONAL {{ ?s schema:description ?sDescription . FILTER(LANG(?sDescription) = "en") }}
  OPTIONAL {{ ?s wdt:P18 ?img . }}
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
            timeout=180,
        )
    except (httpx.TransportError, httpx.TimeoutException, OSError) as e:
        raise _Retryable(str(e)) from e
    if resp.status_code == 429 or resp.status_code >= 500:
        raise _Retryable(f"HTTP {resp.status_code}")
    if resp.status_code == 400:                       # query error — not transient
        raise RuntimeError(f"QLever rejected the query (400): {resp.text[:200]}")
    resp.raise_for_status()
    try:
        return json.loads(resp.text, strict=False)["results"]["bindings"]
    except (json.JSONDecodeError, KeyError) as e:
        raise _Retryable(f"bad body: {e}") from e


def _qid(uri: str) -> str:
    """'http://www.wikidata.org/entity/Q42' → 'Q42' (already-bare passes through)."""
    return uri.rsplit("/", 1)[-1]


def _val(b: dict, key: str) -> str | None:
    v = b.get(key)
    return v.get("value") if v else None


def _batches(items: list[str], n: int):
    for i in range(0, len(items), n):
        yield items[i:i + n]


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
        agg: dict[str, dict] = {q: {"creators": set(), "depicts": set(), "dlabels": {},
                                    "collection": None, "movement": None, "nb": 0} for q in batch}
        try:
            for b in _wd_query(client, _Q_WORKS.format(values=values)):
                q = _qid(_val(b, "item") or "")
                if q not in agg:
                    continue
                if (c := _val(b, "creator")):
                    cq = _qid(c)
                    if re.fullmatch(r"Q\d+", cq):   # discard stale hash-format non-QIDs
                        agg[q]["creators"].add(cq)
                if (d := _val(b, "depicts")):
                    dq = _qid(d)
                    agg[q]["depicts"].add(dq)
                    if (dl := _val(b, "depictsLabel")) and dl != dq:
                        agg[q]["dlabels"][dq] = dl
                if (col := _val(b, "collection")) and not agg[q]["collection"]:
                    agg[q]["collection"] = _qid(col)
                if (m := _val(b, "movementLabel")) and not agg[q]["movement"]:
                    agg[q]["movement"] = m
                if (nb := _val(b, "nb")):
                    try:
                        agg[q]["nb"] = max(agg[q]["nb"], int(nb))
                    except ValueError:
                        pass
        except Exception as e:  # greedy: keep what we have, skip this window
            print(f"  works batch failed ({e}); skipping {len(batch)} qids")
        for q, a in agg.items():
            dsorted = sorted(a["depicts"])
            out[q] = {
                # numerically-lowest QID = the most-established creator entity, not the
                # lexicographically-first (Q100 should beat Q99999).
                "artist_qid": (min(a["creators"], key=lambda c: int(c[1:])) if a["creators"] else None),
                "depicts_qids": " ".join(dsorted) or None,
                # labels index-aligned with depicts_qids (display-only; pills).
                "depicts_labels": json.dumps([a["dlabels"].get(dq, dq) for dq in dsorted],
                                             ensure_ascii=False) if dsorted else None,
                "collection_qid": a["collection"],
                "movement": a["movement"],
                "nb_sitelinks": a["nb"] or None,
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
                # Decode %20→space etc. so the runtime's Special:FilePath URL doesn't
                # double-encode ("%2520") and 404 the artist portrait.
                e["imageCommons"] = e["imageCommons"] or urllib.parse.unquote(_qid(img))
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
                "imageCommons": urllib.parse.unquote(_qid(img)) if img else None,
                "workCount": counts.get(q, 0),
            }
    return out


def _clean(d: dict) -> dict:
    """Drop None/empty values so the static JSON stays small."""
    return {k: v for k, v in d.items() if v not in (None, "", [], set())}


def build_name_to_qid(artists: dict[str, dict]) -> dict[str, str]:
    """RAW name → QID (label + English aliases, first-wins). Deliberately does NO
    normalization: the runtime (packages/core normalize() + the index builder in
    adapters.ts) is the single source of truth for name matching — this only emits
    facts, so there is no Python/TS normalize() to keep in sync."""
    out: dict[str, str] = {}
    for q, e in artists.items():
        for nm in filter(None, [e.get("labelEn"), *(e.get("aliases") or [])]):
            out.setdefault(nm, q)
    return out


def enrich(repo: str = "NullSense/harpe-art", out: str | None = None) -> None:
    """Build + publish the knowledge-graph entity layer from the published works.
    Callable as a final phase of ingest.py (--enrich) or standalone (this script)."""
    out = out or os.path.join(tempfile.gettempdir(), "harpe-train-enriched.parquet")
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    from huggingface_hub import HfApi, hf_hub_download
    from huggingface_hub import CommitOperationAdd

    print("Downloading published works…")
    train = hf_hub_download(repo_id=repo, repo_type="dataset", filename="data/train.parquet")

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
    api = HfApi()

    # ── Phase A — publish the per-work KG columns FIRST ────────────────────────
    # The works→creator/depicts/collection/movement pass (checkpointed, resumable)
    # is everything the search RESULTS need. Patch it onto the works Parquet and
    # re-publish immediately, BEFORE the slower entity-page harvest — so card
    # enrichment goes live on its own, and a Phase-B failure can't undo it.
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

    print("Patching works Parquet…")
    rows = [(q, e.get("artist_qid"), e.get("depicts_qids"), e.get("depicts_labels"),
             e.get("collection_qid"), e.get("movement"), e.get("nb_sitelinks")) for q, e in work_ent.items()]
    con.execute("CREATE TABLE enr (wikidata_qid VARCHAR, artist_qid VARCHAR, depicts_qids VARCHAR, "
                "depicts_labels VARCHAR, collection_qid VARCHAR, movement VARCHAR, nb_sitelinks INTEGER)")
    con.executemany("INSERT INTO enr VALUES (?,?,?,?,?,?,?)", rows)
    enr_cols = ["artist_qid", "depicts_qids", "depicts_labels", "collection_qid", "movement", "nb_sitelinks"]
    present = [c for c in enr_cols if c in cols]
    excl = f"EXCLUDE ({', '.join(present)})" if present else ""
    oq = out.replace("'", "''")
    con.execute(
        f"COPY (SELECT w.* {excl}, e.artist_qid, e.depicts_qids, e.depicts_labels, "
        f"e.collection_qid, e.movement, e.nb_sitelinks "
        f"FROM read_parquet('{tq}') w LEFT JOIN enr e USING (wikidata_qid)) "
        f"TO '{oq}' (FORMAT parquet, COMPRESSION zstd)"
    )
    con.close()

    print("Uploading patched works Parquet…")
    api.upload_file(path_or_fileobj=out, path_in_repo="data/train.parquet",
                    repo_id=repo, repo_type="dataset")
    print("✓ Phase A live: search cards now carry artist_qid / depicts / movement "
          "(redeploy Vercel to serve). Building entity pages next…")

    # ── Phase B — artist + subject entity pages (the /artist + /depicts detail
    # pages and non-Wikidata name resolution). Slower; published as a separate
    # commit so it never blocks the card enrichment above. Checkpointed BEFORE the
    # push so a commit failure (e.g. an HF limit) never re-runs the ~16 min harvest.
    if os.path.exists(_ENT_CKPT):
        d = json.load(open(_ENT_CKPT))
        artists, subjects = d["artists"], d["subjects"]
        client.close()
        print(f"resuming entity push from checkpoint: {len(artists):,} artists, {len(subjects):,} subjects")
    else:
        artist_qids = sorted(artist_counts)
        print(f"{len(artist_qids):,} distinct artists")
        artists = harvest_artists(client, artist_qids, artist_counts)

        top_subjects = sorted(subject_counts, key=lambda s: -subject_counts[s])[:_SUBJECT_CAP]
        print(f"{len(top_subjects):,} subjects (capped at {_SUBJECT_CAP:,})")
        subjects = harvest_subjects(client, top_subjects, subject_counts)
        client.close()
        json.dump({"artists": artists, "subjects": subjects}, open(_ENT_CKPT, "w"))

    # name_to_qid.json → published to the HF CDN as part of the entity layer (the
    # runtime resolves non-Wikidata artist names to QIDs from it; Wikidata works
    # already carry artist_qid directly). Rebuilt from `artists` — never sourced.
    name_to_qid = build_name_to_qid(artists)
    print(f"{len(name_to_qid):,} name→QID entries")

    # Entity files are SHARDED into bucket bundles ({QID: entity} per file): one file
    # per QID hits HF's 10,000-files-per-directory cap (~90k artists). bucket(QID) =
    # int(digits) % _SHARDS — the runtime (adapters.ts) reads the same scheme.
    artist_buckets: dict[int, dict] = defaultdict(dict)
    workid_buckets: dict[int, dict] = defaultdict(dict)
    subject_buckets: dict[int, dict] = defaultdict(dict)
    for q, e in artists.items():
        b = _bucket(q)
        artist_buckets[b][q] = _clean(e)
        workid_buckets[b][q] = work_ids_by_artist.get(q, [])
    for q, e in subjects.items():
        subject_buckets[_bucket(q)][q] = _clean(e)

    # Clear any prior entity layout first — the failed per-file run left orphan
    # files that would (a) re-trip the 10k/dir cap and (b) shadow the new bundles.
    print("Clearing previous entity layout…")
    for sub in ("artists", "work_ids_by_artist", "depicts"):
        try:
            api.delete_folder(path_in_repo=f"data/{sub}", repo_id=repo, repo_type="dataset",
                              commit_message=f"reset data/{sub} for sharded layout")
        except Exception as e:  # noqa: BLE001 — absent folder is fine, keep going
            print(f"  (nothing to clear in data/{sub}: {e})")

    print("Building + pushing sharded entity files…")
    ops = [CommitOperationAdd(
        path_in_repo="data/name_to_qid.json",
        path_or_fileobj=json.dumps(name_to_qid, ensure_ascii=False, separators=(",", ":")).encode(),
    )]
    _J = dict(ensure_ascii=False, separators=(",", ":"))
    for b, m in artist_buckets.items():
        ops.append(CommitOperationAdd(path_in_repo=f"data/artists/{b}.json",
                   path_or_fileobj=json.dumps(m, **_J).encode()))
    for b, m in workid_buckets.items():
        ops.append(CommitOperationAdd(path_in_repo=f"data/work_ids_by_artist/{b}.json",
                   path_or_fileobj=json.dumps(m, separators=(",", ":")).encode()))
    for b, m in subject_buckets.items():
        ops.append(CommitOperationAdd(path_in_repo=f"data/depicts/{b}.json",
                   path_or_fileobj=json.dumps(m, **_J).encode()))

    # ~769 files total → a couple of chunked commits (HF caps operations per commit).
    CHUNK = 256
    for i in tqdm(range(0, len(ops), CHUNK), desc="commit", unit="chunk"):
        api.create_commit(repo_id=repo, repo_type="dataset", operations=ops[i:i + CHUNK],
                          commit_message=f"entity files {i // CHUNK + 1}")

    print(f"\nDone. {len(artists):,} artists, {len(subjects):,} subjects, "
          f"{sum(len(v) for v in work_ids_by_artist.values()):,} artist↔work links "
          f"across {len(artist_buckets)} shards.")
    print("Patched works + entity files are live on the HF CDN — redeploy Vercel to serve them.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the Harpe knowledge-graph entity layer from the published works.")
    ap.add_argument("--repo", default="NullSense/harpe-art", help="HF dataset repo")
    ap.add_argument("--out", default=None, help="local patched-Parquet path (default: a temp file)")
    args = ap.parse_args()
    enrich(args.repo, args.out)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted — the works entity pass is checkpointed; re-run to resume.")
        raise SystemExit(130)
