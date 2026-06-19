# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "duckdb", "httpx", "tenacity", "tqdm"]
# ///
"""Unit tests for the pure helpers + query plumbing of enrich_entities.py.

Run:  uv run scripts/ingest-art-dumps/test_enrich_entities.py
(the __main__ block invokes pytest on this file with the deps above).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich_entities as E  # noqa: E402


# ── pure helpers ──────────────────────────────────────────────────────────────

def test_qid_strips_iri_and_passes_bare():
    assert E._qid("http://www.wikidata.org/entity/Q42") == "Q42"
    assert E._qid("Q42") == "Q42"
    assert E._qid("https://x/y/Q5582") == "Q5582"


def test_val_extracts_binding_value_or_none():
    assert E._val({"a": {"value": "x"}}, "a") == "x"
    assert E._val({}, "a") is None
    assert E._val({"a": {}}, "a") is None  # binding present but no .value


def test_batches_chunks_evenly_and_remainder():
    assert list(E._batches([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]
    assert list(E._batches([], 3)) == []
    assert list(E._batches([1, 2], 5)) == [[1, 2]]


def test_clean_drops_empty_values():
    assert E._clean({"a": 1, "b": None, "c": "", "d": [], "e": set(), "f": "ok"}) == {"a": 1, "f": "ok"}


def test_bucket_matches_adapters_ts_scheme():
    # MUST equal adapters.ts entityBucket: int(qid[1:]) % 256. Pins cross-language parity.
    assert E._SHARDS == 256
    assert E._bucket("Q5") == 5
    assert E._bucket("Q146") == 146
    assert E._bucket("Q41406") == 190
    assert E._bucket("Q1144558") == 238
    assert E._bucket("Q119007077") == 101


def test_build_name_to_qid_label_and_aliases_first_wins():
    artists = {
        "Q5582": {"labelEn": "Vincent van Gogh", "aliases": ["van Gogh", "Vincent Willem van Gogh"]},
        "Q41406": {"labelEn": "Claude Monet", "aliases": []},
        "Q999": {"labelEn": "Vincent van Gogh", "aliases": []},  # collides → first (Q5582) wins
        "Q1000": {"labelEn": None, "aliases": ["Anon"]},          # no label → alias only
    }
    out = E.build_name_to_qid(artists)
    assert out["Vincent van Gogh"] == "Q5582"   # first-wins over Q999
    assert out["van Gogh"] == "Q5582"
    assert out["Claude Monet"] == "Q41406"
    assert out["Anon"] == "Q1000"


# ── _wd_query: POST (not GET) + error mapping ────────────────────────────────

class _Resp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text if text else (E.json.dumps(payload) if payload is not None else "")

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _Client:
    """Records whether .post (correct) or .get (the old, 414-prone path) was used."""
    def __init__(self, resp):
        self._resp = resp
        self.post_called = False
        self.get_called = False

    def post(self, url, data=None, headers=None, timeout=None):
        self.post_called = True
        self.last_data = data
        return self._resp

    def get(self, url, params=None, headers=None, timeout=None):
        self.get_called = True
        return self._resp


def test_wd_query_uses_post_with_query_body():
    bindings = [{"item": {"value": "http://www.wikidata.org/entity/Q42"}}]
    client = _Client(_Resp(200, {"results": {"bindings": bindings}}))
    out = E._wd_query(client, "SELECT * WHERE {}")
    assert out == bindings
    assert client.post_called and not client.get_called          # POST, never GET (avoids 414)
    assert client.last_data == {"query": "SELECT * WHERE {}"}    # query in the BODY


def test_wd_query_400_is_fatal_not_retried():
    client = _Client(_Resp(400, text="bad query"))
    with pytest.raises(RuntimeError):
        E._wd_query(client, "BROKEN")


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-q"]))
