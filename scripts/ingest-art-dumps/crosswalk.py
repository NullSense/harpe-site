"""Wikidata external-id crosswalk: {museum object id → QID}, the stable hub link.

Wikidata already holds EXACT links from a museum's own object id to the artwork's
QID, via external-identifier properties (P3634 Met, P4610 AIC, …). One QLever query
per property builds a {dump_id → QID} map; an exact id-join then fills `wikidata_qid`
on rows that lack it — no per-source wikidata-field scraping, no fuzzy title match.

Why this matters (the "insane loop" fix): the crosswalk reads the PUBLISHED parquet
and patches it in place, so QID coverage improves on a plain `--crosswalk --push`
with NO re-harvest of any source. The query is identical every run → cacheable and
incremental. It's the only exact QID source for museums whose own data carries no
wikidata field at all (AIC, Smithsonian, Harvard, Cleveland, MoMA).

Match counts are LOGGED per source: a museum whose native id doesn't line up with the
property's value format shows up as a low/zero count (never a silent no-op).
"""
import json
import os
import re

from paths import cache_path

QLEVER = "https://qlever.dev/api/wikidata"

# dump `source` (== the id prefix `<source>-<native_id>`) → Wikidata external-id
# property whose VALUE is that same native id. Verified present + populated on
# Wikidata (2026-06; counts: nga 128k, met 72k, si 16.5k, harvard 5.9k, moma 5.2k,
# aic 3.2k, cleveland 211). Met/NGA also expose their QID first-party, so for them
# the crosswalk is a supplement; for the rest it's the only exact link.
CROSSWALK_PROPS = {
    "met": "P3634",        # Met object ID
    "aic": "P4610",        # Art Institute of Chicago (ARTIC) artwork ID
    "cleveland": "P11110",  # Cleveland Museum of Art ID
    "moma": "P2014",       # Museum of Modern Art work ID
    "nga": "P4683",        # National Gallery of Art artwork ID
    "harvard": "P10121",   # Harvard Art Museums artwork ID
    "si": "P4704",         # Smithsonian American Art Museum artwork ID
}

_QID_RE = re.compile(r"^Q\d+$")


def crosswalk_id(source: str, pvalue: str) -> str:
    """The dump-row id a crosswalk entry targets — must match ingest.py's
    `'<source>-' || native_id` exactly, or the join fills nothing."""
    return f"{source}-{pvalue}"


def _qlever(query: str, timeout: float = 300.0) -> list[tuple[str, ...]]:
    """Run a SPARQL query against QLever, returning each binding as a tuple of values
    in `head.vars` order. Network only; tests inject a fake query function instead."""
    import httpx

    r = httpx.get(QLEVER, params={"query": query},
                  headers={"Accept": "application/sparql-results+json"},
                  timeout=timeout, follow_redirects=True)
    r.raise_for_status()
    data = r.json()
    vars_ = data["head"]["vars"]
    out: list[tuple[str, ...]] = []
    for b in data["results"]["bindings"]:
        out.append(tuple(b.get(v, {}).get("value", "") for v in vars_))
    return out


def fetch_property(source: str, prop: str, query=_qlever) -> dict[str, str]:
    """One property → {dump_id: QID}. Skips malformed ids/QIDs."""
    sparql = (
        "PREFIX wdt: <http://www.wikidata.org/prop/direct/>\n"
        f"SELECT ?id ?item WHERE {{ ?item wdt:{prop} ?id . }}"
    )
    out: dict[str, str] = {}
    for row in query(sparql):
        if len(row) < 2:
            continue
        pid, item = row[0], row[1]
        qid = item.rsplit("/", 1)[-1]
        if pid and _QID_RE.match(qid):
            out[crosswalk_id(source, pid)] = qid
    return out


def build_crosswalk(path: str | None = None, props: dict[str, str] = CROSSWALK_PROPS,
                    query=_qlever, refresh: bool = False) -> dict[str, str]:
    """Build (or load from the durable cache) the merged {dump_id: QID} crosswalk.
    A per-property failure is logged and skipped, never fatal."""
    path = path or cache_path("crosswalk.json")
    if not refresh and os.path.exists(path):
        try:
            return json.load(open(path))
        except Exception:
            pass  # corrupt cache → rebuild
    merged: dict[str, str] = {}
    for source, prop in props.items():
        try:
            m = fetch_property(source, prop, query=query)
            merged.update(m)
            print(f"crosswalk {source} ({prop}): {len(m):,} ids")
        except Exception as e:  # noqa: BLE001 — one source must not sink the rest
            print(f"crosswalk {source} ({prop}): FAILED ({e})")
    json.dump(merged, open(path, "w"))
    return merged


def apply_crosswalk_to_parquet(parquet_path: str, crosswalk: dict[str, str], con=None) -> dict[str, int]:
    """Fill `wikidata_qid` on rows that lack one, by EXACT id-join with the crosswalk.
    Rewrites the parquet in place. Returns per-source counts of rows newly filled
    (so a format mismatch surfaces as a low/zero count, not a silent no-op)."""
    import duckdb

    own = con is None
    con = con or duckdb.connect()
    try:
        con.execute("CREATE OR REPLACE TEMP TABLE _xwalk (id VARCHAR, qid VARCHAR)")
        if crosswalk:
            con.executemany("INSERT INTO _xwalk VALUES (?, ?)", list(crosswalk.items()))
        pq = parquet_path.replace("'", "''")
        cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{pq}')").fetchall()]
        has_qid = "wikidata_qid" in cols
        filled_pred = "(w.wikidata_qid IS NULL OR w.wikidata_qid = '')" if has_qid else "TRUE"
        counts = dict(con.execute(
            f"SELECT split_part(w.id, '-', 1) AS src, COUNT(*) "
            f"FROM read_parquet('{pq}') w JOIN _xwalk x ON w.id = x.id "
            f"WHERE {filled_pred} GROUP BY 1"
        ).fetchall())

        sel = ("w.* REPLACE (COALESCE(NULLIF(w.wikidata_qid, ''), x.qid) AS wikidata_qid)"
               if has_qid else "w.*, x.qid AS wikidata_qid")
        out = parquet_path + ".xwalk"
        con.execute(
            f"COPY (SELECT {sel} FROM read_parquet('{pq}') w "
            f"LEFT JOIN _xwalk x ON w.id = x.id) "
            f"TO '{out.replace(chr(39), chr(39) * 2)}' (FORMAT parquet, COMPRESSION zstd)"
        )
        os.replace(out, parquet_path)
        return {k: int(v) for k, v in counts.items()}
    finally:
        if own:
            con.close()


def run(repo: str = "NullSense/harpe-art", query=_qlever) -> dict[str, int]:
    """Build the crosswalk, apply it to the published parquet, and push it back.
    Improves QID coverage with NO source re-harvest. Returns per-source fill counts."""
    import shutil
    import tempfile

    from huggingface_hub import HfApi, hf_hub_download

    xwalk = build_crosswalk(query=query)
    print(f"crosswalk: {len(xwalk):,} total museum→QID links")
    train = hf_hub_download(repo_id=repo, repo_type="dataset", filename="data/train.parquet")
    work = os.path.join(tempfile.gettempdir(), "harpe-xwalk-train.parquet")
    shutil.copy(train, work)  # hf_hub_download returns a read-only cache path
    counts = apply_crosswalk_to_parquet(work, xwalk)
    total = sum(counts.values())
    print(f"crosswalk: filled wikidata_qid on {total:,} rows — "
          + (", ".join(f"{k}={v:,}" for k, v in sorted(counts.items())) or "none"))
    HfApi().upload_file(path_or_fileobj=work, path_in_repo="data/train.parquet",
                        repo_id=repo, repo_type="dataset")
    print("crosswalk: pushed patched parquet. Run `--enrich-only --push` to fold the "
          "new QIDs into canonical_id / same-as.")
    return counts
