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
import unicodedata
import urllib.parse
from collections import defaultdict, Counter

import duckdb
import httpx
import tenacity
from tqdm import tqdm

from paths import cache_path

# QLever: a SPARQL engine over the full Wikidata dump with no 60s timeout — the
# same endpoint the harvest uses. Far faster than WDQS for this VALUES-driven pass,
# and it lets us use big batches. It needs explicit PREFIXes and rdfs:label /
# schema:description joins (no WDQS `SERVICE wikibase:label`). Results aggregated in
# Python.
# qlever.cs.uni-freiburg.de now 308-redirects to qlever.dev (and 308 isn't followed
# for POST), so target the canonical host directly.
_WDQS = "https://qlever.dev/api/wikidata"
_UA = "HarpeArtIngest/1.0 (github.com/NullSense/harpe; matas234@gmail.com)"
_BATCH = 1000        # QIDs per VALUES block — QLever handles big blocks fast
_SUBJECT_CAP = 4000  # build depicts entity files only for the most-used subjects
_CKPT = cache_path("entities.json")  # durable (~/.cache) so a reboot resumes, not recomputes
# Entity files are SHARDED into bucket bundles ({QID: entity} per file) because HF
# caps any directory at 10,000 files — one-file-per-QID (~90k artists) blows past it.
# bucket = int(QID-digits) % _SHARDS. The runtime (adapters.ts `entityBucket`) MUST
# use the identical scheme; both are covered by parity tests. 256 → ~350 artists per
# ~100 KB bundle, 256 files/dir (well under the cap), ~769 files total (was ~184k).
_SHARDS = 256
# Built artists+subjects are checkpointed here BEFORE the push, so a failed/slow HF
# commit never forces a re-harvest of the ~16 min artist pass — re-run resumes here.
_ENT_CKPT = cache_path("entities-built.json")
# R3 same-as remap (member QID → canonical QID) checkpointed so a re-run skips the
# ~12-min P460 pass. Cleared by `rm` of _CKPT (same as the work harvest).
_SAMEAS_CKPT = cache_path("sameas-clusters.json")


def _bucket(qid: str) -> int:
    """Shard key for an entity QID — MUST match adapters.ts `entityBucket`."""
    return int(qid[1:]) % _SHARDS

# Generic titles that must NEVER key the work_index (every artist has dozens) — a
# match on these would falsely fold unrelated works. Mirrors the spirit of search.ts
# GENERIC_TITLES, kept deliberately small + obvious.
_GENERIC_TITLES = frozenset({
    "", "untitled", "unknown", "no title", "untitled work", "sans titre",
    "self portrait", "portrait of a man", "portrait of a woman", "landscape",
    "still life", "composition", "study", "sketch", "drawing", "painting",
})


def _work_title_key(title: str) -> str:
    """Normalise a title for the work_index. MUST stay byte-identical to adapters.ts
    `workTitleKey`: NFKD-fold, drop combining marks, lowercase, collapse every run of
    non-(letter|number) to a single space, trim. Keeps CJK/Cyrillic letters so a
    Japanese alias matches a Japanese source title. Artist-anchored at lookup, so this
    can be aggressive without cross-artist false merges."""
    s = unicodedata.normalize("NFKD", title or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^0-9\w]+", " ", s, flags=re.UNICODE)  # \w keeps unicode letters/digits
    s = s.replace("_", " ")
    return " ".join(s.split())


# ── R3: collapse Wikidata's OWN duplicate items (impressions/editions) ─────────
# Many QIDs by one artist describe the SAME work (a woodblock print's 100+ surviving
# impressions, an edition + its concept). They share titles → the work_index drops
# the key as ambiguous → the famous work (e.g. The Great Wave) never resolves. We
# collapse P460 ("said to be the same as") components to one canonical QID so all
# impressions' titles key to it. P461 ("different from") vetoes a wrong same-as
# (PHAROS found ~27% of cross-authority same-as links disagree — so we verify).
def _cluster_sameas(same_pairs: list[tuple[str, str]],
                    diff_pairs: list[tuple[str, str]],
                    nb_of: dict[str, int]) -> dict[str, str]:
    """Pure union-find over P460 pairs → {member_qid: canonical_qid} for non-canonical
    members. Symmetrises edges (Wikidata often asserts only one direction). A P461
    edge between two members removes THAT direct same-as edge (splits the pair, not
    the whole component). Canonical = highest nb_sitelinks, tie-break lowest numeric
    QID. Canonical members are omitted from the result (they map to themselves)."""
    diff = {frozenset(p) for p in diff_pairs if p[0] != p[1]}
    parent: dict[str, str] = {}
    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    for a, b in same_pairs:
        if a != b:
            union(a, b)  # symmetric by construction (union is order-independent)
    comps: dict[str, list[str]] = defaultdict(list)
    for q in parent:
        comps[find(q)].append(q)
    out: dict[str, str] = {}
    for members in comps.values():
        if len(members) < 2:
            continue
        ms = set(members)
        # P461 veto (conservative): if ANY "different from" pair sits inside this
        # component, the same-as links are internally inconsistent (PHAROS: ~27% do
        # disagree) — leave the whole component uncollapsed rather than risk a wrong
        # merge. Never merges Monet's distinct "Water Lilies" (they have no P460).
        if any(d <= ms for d in diff):
            continue
        canon = max(members, key=lambda q: (nb_of.get(q, 0), -int(q[1:])))
        for q in members:
            if q != canon:
                out[q] = canon
    return out


def _compute_canonical_id(wikidata_qid: str | None, artist_qid: str | None,
                          title: str | None, wi_flat: dict[str, str]) -> str | None:
    """R2 waterfall: a dump row's canonical Wikidata identity, or None (safe default,
    never a false merge). (1) the row's own wikidata_qid (already same-as-collapsed in
    work_ent); (2) else resolve via the alias work_index keyed (normTitle, artist_qid);
    (3) else None. Pure + unit-tested; called from the canonical_id patch in enrich()."""
    if wikidata_qid and re.fullmatch(r"Q\d+", wikidata_qid):
        return wikidata_qid
    if artist_qid and re.fullmatch(r"Q\d+", artist_qid) and title:
        return wi_flat.get(f"{_work_title_key(title)}~{artist_qid}")
    return None

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
_Q_WORKS = _PREFIX + """SELECT ?item ?creator ?depicts ?depictsLabel ?collection ?movementLabel ?nb ?label ?alias ?p1476 WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wdt:P170 ?creator . }}
  OPTIONAL {{ ?item wdt:P180 ?depicts . OPTIONAL {{ ?depicts rdfs:label ?depictsLabel . FILTER(LANG(?depictsLabel) = "en") }} }}
  OPTIONAL {{ ?item wdt:P195 ?collection . }}
  OPTIONAL {{ ?item wdt:P135 ?movement . OPTIONAL {{ ?movement rdfs:label ?movementLabel . FILTER(LANG(?movementLabel) = "en") }} }}
  OPTIONAL {{ ?item wikibase:sitelinks ?nb . }}
  OPTIONAL {{ ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }}
  OPTIONAL {{ ?item skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }}
  OPTIONAL {{ ?item wdt:P1476 ?p1476 . }}
}}
"""
# P460 "said to be the same as" / P461 "different from" — for R3 impression collapse.
_Q_SAMEAS = _PREFIX + """SELECT ?item ?same ?diff WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wdt:P460 ?same . }}
  OPTIONAL {{ ?item wdt:P461 ?diff . }}
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
        # POST (form-encoded body), NOT GET: a batch of 1000 QIDs makes the query
        # string exceed QLever's URI limit → HTTP 414. The body has no such limit.
        resp = client.post(
            _WDQS, data={"query": query},
            headers={"Accept": "application/sparql-results+json", "User-Agent": _UA},
            timeout=180,
        )
    except (httpx.TransportError, httpx.TimeoutException, OSError) as e:
        raise _Retryable(str(e)[:200]) from e
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
            # Schema guard: entries written before the title harvest lack the "titles"
            # key. Resuming from such a checkpoint would skip every work and leave the
            # work_index empty. If ANY entry predates titles, discard and re-harvest
            # (≈12 min) so the index is complete — no manual rm of the checkpoint needed.
            if out and not all("titles" in v for v in out.values()):
                print(f"  checkpoint ({len(out):,} works) predates title harvest — "
                      "discarding to re-harvest titles for the work_index")
                out = {}
            else:
                print(f"  resuming: {len(out):,} works already enriched")
        except Exception:
            out = {}
    todo = [q for q in qids if q not in out]
    failed = 0
    for batch in tqdm(list(_batches(todo, _BATCH)), desc="works", unit="batch"):
        values = " ".join(f"wd:{q}" for q in batch)
        agg: dict[str, dict] = {q: {"creators": set(), "depicts": set(), "dlabels": {},
                                    "collection": None, "movement": None, "nb": 0,
                                    "titles": set()} for q in batch}
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
                # Title variants (label + EN aliases + any-language P1476 title) feed
                # the work_index so the SAME work folds across sources that title it
                # differently ("The Great Wave" ↔ "Under the Wave off Kanagawa").
                for tkey in ("label", "alias", "p1476"):
                    if (tv := _val(b, tkey)):
                        agg[q]["titles"].add(tv)
        except Exception as e:
            # A failed query returns ZERO rows → agg is all-defaults. Writing that to
            # `out` would checkpoint nb=0/None for the whole batch AND mark it done
            # (resume skips it forever). So skip the batch entirely and retry next run
            # — matches harvest_artists. (Mirrors the correct `continue` pattern.)
            failed += 1
            tqdm.write(f"  works batch failed ({str(e)[:160]}); skipping {len(batch)} qids")
            continue
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
                # all known title variants → work_index keys (display title untouched).
                "titles": sorted(a["titles"]) or None,
            }
        json.dump(out, open(_CKPT, "w"))  # checkpoint after every successful batch
    if failed:
        print(f"  works: {failed} batch(es) failed (will retry on re-run); {len(out):,} enriched so far")
    return out


# ── R3: same-as cluster harvest (P460/P461) ───────────────────────────────────
def build_sameas_clusters(client: httpx.Client, work_ent: dict[str, dict]) -> dict[str, str]:
    """Query P460/P461 for every harvested work QID and collapse same-as components
    to one canonical QID. Returns {member_qid: canonical_qid} for non-canonical
    members only. Pure clustering is in _cluster_sameas (unit-tested); this just does
    the SPARQL + nb lookup. A failed batch is skipped (no remap for it) — safe."""
    qids = list(work_ent)
    same_pairs: list[tuple[str, str]] = []
    diff_pairs: list[tuple[str, str]] = []
    for batch in tqdm(list(_batches(qids, _BATCH)), desc="same-as", unit="batch"):
        values = " ".join(f"wd:{q}" for q in batch)
        try:
            rows = _wd_query(client, _Q_SAMEAS.format(values=values))
        except Exception as e:
            tqdm.write(f"  same-as batch failed ({str(e)[:160]}); skipping {len(batch)}")
            continue
        for b in rows:
            q = _qid(_val(b, "item") or "")
            if (s := _val(b, "same")):
                sq = _qid(s)
                if re.fullmatch(r"Q\d+", sq):
                    same_pairs.append((q, sq))
            if (d := _val(b, "diff")):
                dq = _qid(d)
                if re.fullmatch(r"Q\d+", dq):
                    diff_pairs.append((q, dq))
    nb_of = {q: (e.get("nb_sitelinks") or 0) for q, e in work_ent.items()}
    remap = _cluster_sameas(same_pairs, diff_pairs, nb_of)
    print(f"  same-as: {len(same_pairs):,} P460 pairs, {len(diff_pairs):,} P461 → "
          f"{len(remap):,} impressions remapped to canonical QIDs")
    return remap


# ── Step 4a: artist metadata ──────────────────────────────────────────────────
def harvest_artists(client: httpx.Client, qids: list[str], work_counts: dict[str, int]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for batch in tqdm(list(_batches(qids, _BATCH)), desc="artists", unit="batch"):
        values = " ".join(f"wd:{q}" for q in batch)
        try:
            rows = _wd_query(client, _Q_ARTISTS.format(values=values))
        except Exception as e:
            tqdm.write(f"  artists batch failed ({str(e)[:160]}); skipping {len(batch)}")
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
            tqdm.write(f"  subjects batch failed ({str(e)[:160]}); skipping {len(batch)}")
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


def build_suggest(artists: dict[str, dict], subjects: dict[str, dict],
                  max_artists: int = 4000, max_subjects: int = 1500) -> list[dict]:
    """KG-derived autocomplete pool — REPLACES the hand-curated static lists in the
    frontend (discover.ts). Fame-ranked by workCount so the dropdown leads with the
    artists/subjects users actually search; each entry carries its QID so a pick can
    jump straight to the enriched page. Movements are aggregated from artist P135."""
    out: list[dict] = []
    top_a = sorted((e for e in artists.values() if e.get("labelEn")),
                   key=lambda e: e.get("workCount") or 0, reverse=True)[:max_artists]
    for e in top_a:
        hint = " · ".join(x for x in (e.get("nationality"),
                          (e.get("movementLabels") or [None])[0]) if x)
        out.append({"label": e["labelEn"], "qid": e["qid"], "kind": "artist",
                    "hint": hint or None, "n": e.get("workCount") or 0})
    top_s = sorted((e for e in subjects.values() if e.get("labelEn")),
                   key=lambda e: e.get("workCount") or 0, reverse=True)[:max_subjects]
    for e in top_s:
        out.append({"label": e["labelEn"], "qid": e["qid"], "kind": "subject",
                    "hint": e.get("description") or None, "n": e.get("workCount") or 0})
    mv: Counter = Counter()
    for e in artists.values():
        for m in (e.get("movementLabels") or []):
            mv[m] += 1
    for label, n in mv.most_common(80):
        out.append({"label": label, "kind": "movement", "query": label, "n": n})
    return out


def enrich(repo: str = "NullSense/harpe-art", out: str | None = None,
           build_search_index: bool = True) -> None:
    """Build + publish the knowledge-graph entity layer from the published works.
    Callable as a final phase of ingest.py (--enrich) or standalone (this script).
    When build_search_index is set, also builds + uploads the FTS5 search index
    (data/art.sqlite) for browser-side range-read search — see docs/perf-rank4-fts.md."""
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
    if not work_ent:
        client.close()
        raise SystemExit(
            "No work entities were harvested — every QLever batch failed (check connectivity "
            "to qlever.dev). Nothing to patch; aborting before touching the published dataset."
        )

    # ── R3 — same-as collapse: map each impression/edition QID → its canonical QID,
    # so the Great-Wave-class works (many QIDs by one artist sharing a title) fold to
    # ONE identity instead of being dropped as ambiguous in the work_index. Resumable.
    if os.path.exists(_SAMEAS_CKPT):
        try:
            sameas_map = json.load(open(_SAMEAS_CKPT))
            print(f"  same-as: resuming from checkpoint ({len(sameas_map):,} remaps)")
        except Exception:
            sameas_map = build_sameas_clusters(client, work_ent)
            json.dump(sameas_map, open(_SAMEAS_CKPT, "w"))
    else:
        sameas_map = build_sameas_clusters(client, work_ent)
        json.dump(sameas_map, open(_SAMEAS_CKPT, "w"))
    # canonical_id per work = the same-as canonical (self if not remapped). Stored as a
    # Parquet column so the runtime folds impressions WITHOUT any title matching.
    def canon(q: str) -> str:
        return sameas_map.get(q, q)

    # roll up: artist work-ids, work-counts, subject freqs — keyed on the CANONICAL id
    # so impressions don't inflate an artist's work count or list 100× "Great Wave".
    work_ids_by_artist: dict[str, list[str]] = defaultdict(list)
    _seen_artist_work: set[tuple[str, str]] = set()
    artist_counts: dict[str, int] = defaultdict(int)
    subject_counts: dict[str, int] = defaultdict(int)
    for q, e in work_ent.items():
        cq = canon(q)
        if e.get("artist_qid"):
            key = (e["artist_qid"], cq)
            if key not in _seen_artist_work:           # dedupe collapsed impressions
                _seen_artist_work.add(key)
                work_ids_by_artist[e["artist_qid"]].append(f"wd-{cq}")
                artist_counts[e["artist_qid"]] += 1
        for d in (e.get("depicts_qids") or "").split():
            subject_counts[d] += 1

    print("Patching works Parquet…")
    rows = [(q, e.get("artist_qid"), e.get("depicts_qids"), e.get("depicts_labels"),
             e.get("collection_qid"), e.get("movement"), e.get("nb_sitelinks"), canon(q))
            for q, e in work_ent.items()]
    con.execute("CREATE TABLE enr (wikidata_qid VARCHAR, artist_qid VARCHAR, depicts_qids VARCHAR, "
                "depicts_labels VARCHAR, collection_qid VARCHAR, movement VARCHAR, nb_sitelinks INTEGER, "
                "canonical_id VARCHAR)")
    con.executemany("INSERT INTO enr VALUES (?,?,?,?,?,?,?,?)", rows)
    enr_cols = ["artist_qid", "depicts_qids", "depicts_labels", "collection_qid", "movement", "nb_sitelinks", "canonical_id"]
    present = [c for c in enr_cols if c in cols]
    excl = f"EXCLUDE ({', '.join(present)})" if present else ""
    oq = out.replace("'", "''")
    con.execute(
        f"COPY (SELECT w.* {excl}, e.artist_qid, e.depicts_qids, e.depicts_labels, "
        f"e.collection_qid, e.movement, e.nb_sitelinks, e.canonical_id "
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
    # Only resume from a checkpoint that actually HAS artists — an earlier run whose
    # harvest failed (QLever blip → all batches skipped) would have written an empty
    # {} and then every later run "resumes" 0 artists and pushes 0 shards forever.
    ckpt = None
    if os.path.exists(_ENT_CKPT):
        try:
            d = json.load(open(_ENT_CKPT))
            if d.get("artists"):
                ckpt = d
        except Exception:
            ckpt = None
    if ckpt is not None:
        artists, subjects = ckpt["artists"], ckpt["subjects"]
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
        if artists:  # never checkpoint an empty harvest (it would poison resumes)
            json.dump({"artists": artists, "subjects": subjects}, open(_ENT_CKPT, "w"))
        else:
            print("  WARNING: artist harvest returned 0 — not checkpointing (will retry next run)")

    # name_to_qid.json → published to the HF CDN as part of the entity layer (the
    # runtime resolves non-Wikidata artist names to QIDs from it; Wikidata works
    # already carry artist_qid directly). Rebuilt from `artists` — never sourced.
    name_to_qid = build_name_to_qid(artists)
    print(f"{len(name_to_qid):,} name→QID entries")

    # subject_to_qid.json → lets a plain search ("Joan of Arc") resolve to a SUBJECT
    # QID so the runtime can surface its knowledge-graph page (works depicting it +
    # the subject card) instead of a dumb text search. Mirror of name_to_qid for the
    # harvested subjects; raw label → QID (runtime owns normalization).
    subject_to_qid = {e["labelEn"]: q for q, e in subjects.items() if e.get("labelEn")}
    print(f"{len(subject_to_qid):,} subject→QID entries")

    # suggest.json → the KG-derived autocomplete pool (artists+subjects+movements,
    # fame-ranked). Replaces the frontend's hand-curated static lists; the client
    # lazy-loads it once via /api/suggest. Carries QIDs so a pick opens the card.
    suggest = build_suggest(artists, subjects)
    print(f"{len(suggest):,} suggestions (artists+subjects+movements)")

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

    # ── work_index: title-variant + artist_qid → work QID ──────────────────────
    # The cross-title/-language unifier. At runtime a source's work (Met "Under the
    # Wave off Kanagawa", a Commons JP upload) resolves its artist → QID (name_to_qid),
    # then looks up its normalised title here → the work QID, which dedupe folds with
    # every other copy. Keyed BY artist (sharded on _bucket(artist_qid), entry key
    # "<normtitle>~<artist_qid>"), so an aggressive title norm can't cross-merge
    # different artists. The VALUE is the CANONICAL QID (R3 same-as collapse), so the
    # many impressions of one print whose titles collide now all resolve to ONE QID
    # instead of being dropped as ambiguous — that's what was burying the Great Wave.
    # Ambiguous (dropped) only when two DISTINCT canonical works share a (title,artist).
    work_index_buckets: dict[int, dict] = defaultdict(dict)
    wi_seen: dict[str, str] = {}
    wi_ambiguous: set[str] = set()
    for q, e in work_ent.items():
        aq = e.get("artist_qid")
        if not aq:
            continue
        target = canon(q)  # same-as canonical (self if not an impression)
        for tv in (e.get("titles") or []):
            k = _work_title_key(tv)
            if len(k) < 4 or k in _GENERIC_TITLES:
                continue
            fk = f"{k}~{aq}"
            if fk in wi_ambiguous:
                continue
            prev = wi_seen.get(fk)
            if prev is None:
                wi_seen[fk] = target
            elif prev != target:
                wi_ambiguous.add(fk)  # two DISTINCT canonical works: drop both
    for fk, q in wi_seen.items():
        if fk in wi_ambiguous:
            continue
        work_index_buckets[_bucket(fk.split("~", 1)[1])][fk] = q
    wi_entries = sum(len(v) for v in work_index_buckets.values())
    print(f"{wi_entries:,} work_index entries ({len(wi_ambiguous):,} ambiguous dropped)")

    # Clear any prior entity layout first — the failed per-file run left orphan
    # files that would (a) re-trip the 10k/dir cap and (b) shadow the new bundles.
    print("Clearing previous entity layout…")
    for sub in ("artists", "work_ids_by_artist", "depicts", "work_index"):
        try:
            api.delete_folder(path_in_repo=f"data/{sub}", repo_id=repo, repo_type="dataset",
                              commit_message=f"reset data/{sub} for sharded layout")
        except Exception as e:  # noqa: BLE001 — absent folder is fine, keep going
            print(f"  (nothing to clear in data/{sub}: {e})")

    print("Building + pushing sharded entity files…")
    ops = [CommitOperationAdd(
        path_in_repo="data/name_to_qid.json",
        path_or_fileobj=json.dumps(name_to_qid, ensure_ascii=False, separators=(",", ":")).encode(),
    ), CommitOperationAdd(
        path_in_repo="data/subject_to_qid.json",
        path_or_fileobj=json.dumps(subject_to_qid, ensure_ascii=False, separators=(",", ":")).encode(),
    ), CommitOperationAdd(
        path_in_repo="data/suggest.json",
        path_or_fileobj=json.dumps(suggest, ensure_ascii=False, separators=(",", ":")).encode(),
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
    for b, m in work_index_buckets.items():
        ops.append(CommitOperationAdd(path_in_repo=f"data/work_index/{b}.json",
                   path_or_fileobj=json.dumps(m, **_J).encode()))

    # ~1k files total → a couple of chunked commits (HF caps operations per commit).
    CHUNK = 256
    for i in tqdm(range(0, len(ops), CHUNK), desc="commit", unit="chunk"):
        api.create_commit(repo_id=repo, repo_type="dataset", operations=ops[i:i + CHUNK],
                          commit_message=f"entity files {i // CHUNK + 1}")

    print(f"\nDone. {len(artists):,} artists, {len(subjects):,} subjects, "
          f"{sum(len(v) for v in work_ids_by_artist.values()):,} artist↔work links, "
          f"{wi_entries:,} work_index entries "
          f"across {len(artist_buckets)} shards.")

    # Build + publish the FTS5 search index from the freshly-enriched parquet (`out`),
    # which carries depicts_labels/_qids + artist_qid. Last so a failure here can't
    # block the entity-file publish above.
    if build_search_index:
        build_fts(out, repo, api=api)

    print("Patched works + entity files are live on the HF CDN — redeploy Vercel to serve them.")


def build_fts(parquet_path: str, repo: str = "NullSense/harpe-art", *,
              api=None, upload: bool = True, out: str | None = None) -> str:
    """Build a SQLite FTS5 search index from the works parquet and (optionally) upload it
    to HF as data/art.sqlite, for browser-side sql.js-httpvfs range-read queries — the
    durable replacement for the slow HF datasets-server /filter on cold queries.

    FTS5 over title/artist/depicts_labels (the same columns the live /filter ILIKEs);
    display columns are stored alongside so the client renders results with no second
    fetch. Built with a fixed page_size so the client's requestChunkSize matches and a
    query pulls only the B-tree/posting pages it touches. Returns the local .sqlite path.
    See docs/perf-rank4-fts.md."""
    import sqlite3
    out = out or os.path.join(tempfile.gettempdir(), "art.sqlite")
    if os.path.exists(out):
        os.remove(out)

    con = duckdb.connect()
    con.execute(f"SET temp_directory='{tempfile.gettempdir()}';")
    pq = parquet_path.replace("'", "''")
    have = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{pq}')").fetchall()}
    # COALESCE columns absent from a partial dump (e.g. the single-source local test
    # subset) so the same builder works on the full set and on fixtures.
    def col(name: str, default: str = "''") -> str:
        return f'"{name}"' if name in have else f"{default} AS {name}"
    select = (
        "SELECT id, source, title, artist, "
        f"{col('date')}, {col('medium')}, image_thumb, image_full, "
        f"{col('width', 'NULL')}, {col('height', 'NULL')}, source_url, "
        "CAST(is_public_domain AS INTEGER) AS is_public_domain, "
        f"{col('wikidata_qid')}, {col('artist_qid')}, {col('depicts_qids')}, "
        f"{col('depicts_labels')}, {col('movement')} "
        f"FROM read_parquet('{pq}')"
    )
    cur = con.execute(select)

    s = sqlite3.connect(out)
    s.execute("PRAGMA page_size=4096")   # MUST precede table creation; matches client requestChunkSize
    s.execute("PRAGMA journal_mode=OFF")
    s.execute("PRAGMA synchronous=OFF")
    s.execute(
        "CREATE TABLE art(id TEXT, source TEXT, title TEXT, artist TEXT, date TEXT, "
        "medium TEXT, image_thumb TEXT, image_full TEXT, width INTEGER, height INTEGER, "
        "source_url TEXT, is_public_domain INTEGER, wikidata_qid TEXT, artist_qid TEXT, "
        "depicts_qids TEXT, depicts_labels TEXT, movement TEXT)"
    )
    n = 0
    placeholders = ",".join("?" * 17)
    while True:
        batch = cur.fetchmany(50_000)
        if not batch:
            break
        s.executemany(f"INSERT INTO art VALUES ({placeholders})", batch)
        n += len(batch)
    s.execute("CREATE VIRTUAL TABLE art_fts USING fts5(title, artist, depicts_labels, "
              "content='art', content_rowid='rowid')")
    s.execute("INSERT INTO art_fts(rowid, title, artist, depicts_labels) "
              "SELECT rowid, title, artist, depicts_labels FROM art")
    s.execute("INSERT INTO art_fts(art_fts) VALUES('optimize')")
    s.commit()
    s.execute("VACUUM")
    s.commit()
    s.close()

    mb = os.path.getsize(out) / 1e6
    print(f"Built FTS index: {n:,} rows → {out} ({mb:.1f} MB)")
    if upload:
        from huggingface_hub import HfApi
        (api or HfApi()).upload_file(
            path_or_fileobj=out, path_in_repo="data/art.sqlite",
            repo_id=repo, repo_type="dataset",
            commit_message=f"FTS search index ({n:,} rows, {mb:.0f} MB)",
        )
        print("Uploaded data/art.sqlite — redeploy with HARPE_FTS_INDEX set to serve it.")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the Harpe knowledge-graph entity layer from the published works.")
    ap.add_argument("--repo", default="NullSense/harpe-art", help="HF dataset repo")
    ap.add_argument("--out", default=None, help="local patched-Parquet path (default: a temp file)")
    ap.add_argument("--no-search-index", action="store_true",
                    help="skip building + uploading the FTS5 search index (data/art.sqlite)")
    args = ap.parse_args()
    enrich(args.repo, args.out, build_search_index=not args.no_search_index)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted — the works entity pass is checkpointed; re-run to resume.")
        raise SystemExit(130)
