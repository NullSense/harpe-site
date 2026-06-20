# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "duckdb", "httpx"]
# ///
"""Unit tests for the Wikidata external-id crosswalk (museum object id → QID).

The network (QLever) is injected as a fake `query`, so these are offline. They pin:
the id-join key construction, the SPARQL-binding parsing, the durable cache, and the
exact-join fill (only empty wikidata_qid filled; existing values never overridden;
per-source match counts reported so a format mismatch is visible, not silent).

Run:  uv run scripts/ingest-art-dumps/test_crosswalk.py
"""
import os
import sys
import tempfile

import duckdb
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crosswalk as X  # noqa: E402


def test_crosswalk_id_matches_dump_id_shape():
    assert X.crosswalk_id("aic", "42") == "aic-42"
    assert X.crosswalk_id("met", "437133") == "met-437133"


def test_props_are_all_valid_property_ids():
    assert X.CROSSWALK_PROPS["met"] == "P3634"
    assert X.CROSSWALK_PROPS["aic"] == "P4610"
    assert all(v[0] == "P" and v[1:].isdigit() for v in X.CROSSWALK_PROPS.values())


def test_namespace_mismatched_sources_are_excluded():
    # cleveland (P11110 = accession) and si (P4704 = SAAM numeric, dump id = EDAN
    # record_ID) live in a DIFFERENT id namespace than the dump row id, so an exact
    # id-join fills 0 rows. They must NOT be in the crosswalk without an accession
    # join key — re-adding them would just relog a misleading 0-match every run.
    assert "cleveland" not in X.CROSSWALK_PROPS
    assert "si" not in X.CROSSWALK_PROPS


def test_fetch_property_parses_bindings_and_drops_junk():
    rows = [
        ("42", "http://www.wikidata.org/entity/Q100"),   # good
        ("7", "http://www.wikidata.org/entity/Q5"),       # good
        ("", "http://www.wikidata.org/entity/Q9"),         # empty id → drop
        ("8", "http://www.wikidata.org/entity/notaqid"),   # bad qid → drop
    ]
    out = X.fetch_property("aic", "P4610", query=lambda _q: rows)
    assert out == {"aic-42": "Q100", "aic-7": "Q5"}


def test_build_crosswalk_merges_sources_and_uses_durable_cache(tmp_path):
    calls = {"n": 0}

    def fake_query(_q):
        calls["n"] += 1
        return [("1", "http://www.wikidata.org/entity/Q1")]

    path = str(tmp_path / "crosswalk.json")
    props = {"aic": "P4610", "met": "P3634"}
    first = X.build_crosswalk(path, props=props, query=fake_query)
    assert first == {"aic-1": "Q1", "met-1": "Q1"}
    assert calls["n"] == 2 and os.path.exists(path)
    # second call reads the cache → no further queries
    second = X.build_crosswalk(path, props=props, query=fake_query)
    assert second == first and calls["n"] == 2


def _tiny_parquet(con, path, rows):
    vals = ", ".join(
        f"('{i}', {'NULL' if q is None else repr(q)})" for i, q in rows
    )
    con.execute(
        f"COPY (SELECT id, CAST(wikidata_qid AS VARCHAR) AS wikidata_qid "
        f"FROM (VALUES {vals}) t(id, wikidata_qid)) "
        f"TO '{path}' (FORMAT parquet)"
    )


def test_apply_fills_only_empty_qids_and_reports_counts(tmp_path):
    con = duckdb.connect()
    pq = str(tmp_path / "train.parquet")
    _tiny_parquet(con, pq, [
        ("aic-1", None),   # empty → fill
        ("aic-2", "Q5"),   # has qid → keep
        ("met-3", ""),     # empty string → fill
        ("nga-4", None),   # no crosswalk entry → stays null
    ])
    xwalk = {"aic-1": "Q100", "aic-2": "Q999", "met-3": "Q300", "aic-9": "Q9"}
    counts = X.apply_crosswalk_to_parquet(pq, xwalk, con=con)

    got = dict(con.execute(f"SELECT id, wikidata_qid FROM read_parquet('{pq}') ORDER BY id").fetchall())
    assert got["aic-1"] == "Q100"   # filled
    assert got["aic-2"] == "Q5"     # NOT overridden
    assert got["met-3"] == "Q300"   # empty-string filled
    assert got["nga-4"] is None     # no entry → untouched
    assert counts == {"aic": 1, "met": 1}  # only the two newly-filled rows
    con.close()


def test_apply_is_a_noop_with_an_empty_crosswalk(tmp_path):
    con = duckdb.connect()
    pq = str(tmp_path / "t.parquet")
    _tiny_parquet(con, pq, [("aic-1", None)])
    assert X.apply_crosswalk_to_parquet(pq, {}, con=con) == {}
    assert con.execute(f"SELECT wikidata_qid FROM read_parquet('{pq}')").fetchone()[0] is None
    con.close()


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
