# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "duckdb", "httpx", "tenacity", "tqdm"]
# ///
"""Unit tests for the first-party Wikidata-QID capture added to ingest.py.

NGA (objects.wikidataid, bare Q-number) and the Met HF dump (objectWikidata_URL /
artistWikidata_URL, full URLs) ship the artwork's own QID — capturing it lets those
works join the R2/R3 same-as collapse with zero title-guessing. These pin the
extraction so a schema/regex drift can't silently drop the QID columns again.

Run:  uv run scripts/ingest-art-dumps/test_ingest.py
"""
import os
import sys

import duckdb
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ingest as I  # noqa: E402


# ── Met: *Wikidata_URL → bare QID ───────────────────────────────────────────────

def test_met_qid_extracts_bare_qid_from_url():
    assert I._met_qid("https://www.wikidata.org/wiki/Q116373732") == "Q116373732"
    assert I._met_qid("http://www.wikidata.org/entity/Q5582") == "Q5582"


def test_met_qid_is_none_for_empty_or_junk():
    assert I._met_qid(None) is None
    assert I._met_qid("") is None
    assert I._met_qid("not-a-url") is None
    assert I._met_qid("https://www.wikidata.org/wiki/") is None


def test_met_select_lists_the_wikidata_columns():
    # The harvest SELECT must request both URL columns (verified present in the Met
    # HF dataset: objectWikidata_URL + artistWikidata_URL) or the QID capture is dead.
    import inspect
    body = inspect.getsource(I.harvest_met_dump)
    assert "objectWikidata_URL" in body
    assert "artistWikidata_URL" in body
    assert '"wikidata_qid": _met_qid(obj_wd)' in body
    assert '"artist_qid": _met_qid(artist_wd)' in body


# ── NGA: objects.wikidataid → wikidata_qid via the SQL's regexp_extract ──────────

def test_nga_sql_captures_wikidata_qid():
    assert "wikidataid" in I.NGA_SQL
    assert "AS wikidata_qid" in I.NGA_SQL


def test_nga_regexp_extract_yields_bare_qid_or_empty():
    # Mirror the exact transform the NGA SQL applies to objects.wikidataid so a value
    # change is caught here, not in production. Bare QID passes; junk → '' (treated as
    # "no QID" by rowToItem's /^Q\d+$/ guard and by enrich_entities).
    con = duckdb.connect()
    rows = con.execute("""
        SELECT regexp_extract(CAST(v AS VARCHAR), 'Q[0-9]+') AS qid
        FROM (VALUES ('Q20172973'), (''), ('n/a'), (NULL)) t(v)
    """).fetchall()
    con.close()
    # Bare QID passes through; '' and 'n/a' → '' (no match); NULL → NULL. All of '',
    # NULL are non-QIDs downstream, so the only row that yields a usable QID is the first.
    assert [r[0] for r in rows] == ["Q20172973", "", "", None]


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
