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


def test_work_title_key_matches_adapters_ts_workTitleKey():
    # MUST equal adapters.ts workTitleKey (verified byte-identical incl. CJK + accents):
    # NFKD-fold, drop marks, lowercase, non-(letter|number)→space, collapse, trim.
    assert E._work_title_key("The Great Wave off Kanagawa") == "the great wave off kanagawa"
    assert (E._work_title_key("Under the Wave off Kanagawa (Kanagawa oki nami ura)")
            == "under the wave off kanagawa kanagawa oki nami ura")
    assert E._work_title_key("Belshazzar's Feast") == "belshazzar s feast"
    assert E._work_title_key("Café Terrace, Arles") == "cafe terrace arles"
    assert E._work_title_key("神奈川沖浪裏") == "神奈川沖浪裏"  # CJK preserved
    assert E._work_title_key("") == ""


def test_generic_titles_are_excluded_from_work_index():
    # Generic titles must never key the index (would falsely fold unrelated works).
    for t in ("untitled", "landscape", "self portrait", "still life"):
        assert E._work_title_key(t) in E._GENERIC_TITLES


# ── KG-derived autocomplete pool (build_suggest) ──────────────────────────────

def test_build_suggest_ranks_shapes_and_drops_unlabeled():
    artists = {
        "Q1": {"qid": "Q1", "labelEn": "Famous", "workCount": 100, "nationality": "French", "movementLabels": ["Impressionism"]},
        "Q2": {"qid": "Q2", "labelEn": "Minor", "workCount": 2, "nationality": None, "movementLabels": []},
        "Q3": {"qid": "Q3", "labelEn": None, "workCount": 50},  # no label → excluded
    }
    subjects = {"Q9": {"qid": "Q9", "labelEn": "cat", "workCount": 30, "description": "feline"}}
    out = E.build_suggest(artists, subjects)

    arts = [s for s in out if s["kind"] == "artist"]
    assert [s["label"] for s in arts] == ["Famous", "Minor"]  # workCount desc; Q3 dropped
    assert arts[0] == {"label": "Famous", "qid": "Q1", "kind": "artist", "hint": "French · Impressionism", "n": 100}

    subs = [s for s in out if s["kind"] == "subject"]
    assert subs[0]["label"] == "cat" and subs[0]["qid"] == "Q9"

    movs = [s for s in out if s["kind"] == "movement"]
    assert any(m["label"] == "Impressionism" and m.get("query") == "Impressionism" for m in movs)


def test_build_suggest_respects_caps():
    artists = {f"Q{i}": {"qid": f"Q{i}", "labelEn": f"A{i}", "workCount": i} for i in range(1, 20)}
    out = E.build_suggest(artists, {}, max_artists=5, max_subjects=0)
    arts = [s for s in out if s["kind"] == "artist"]
    assert len(arts) == 5
    assert arts[0]["label"] == "A19"  # highest workCount first


# ── R3 same-as clustering ─────────────────────────────────────────────────────

def test_cluster_sameas_collapses_a_chain_to_highest_nb():
    # Q10—Q20—Q30 chained by P460; canonical = highest nb_sitelinks (Q20).
    remap = E._cluster_sameas(
        same_pairs=[("Q10", "Q20"), ("Q20", "Q30")],
        diff_pairs=[],
        nb_of={"Q10": 5, "Q20": 30, "Q30": 5},
    )
    assert remap == {"Q10": "Q20", "Q30": "Q20"}  # transitive; Q20 elected


def test_cluster_sameas_tie_breaks_on_lowest_qid():
    remap = E._cluster_sameas([("Q100", "Q5")], [], {"Q100": 0, "Q5": 0})
    assert remap == {"Q100": "Q5"}  # equal nb → lowest numeric QID is canonical


def test_cluster_sameas_p461_veto_leaves_component_uncollapsed():
    # Q1—Q2—Q3 same-as, but Q1 "different from" Q3 → inconsistent → don't collapse.
    remap = E._cluster_sameas(
        same_pairs=[("Q1", "Q2"), ("Q2", "Q3")],
        diff_pairs=[("Q1", "Q3")],
        nb_of={"Q1": 1, "Q2": 1, "Q3": 1},
    )
    assert remap == {}  # whole component vetoed (no wrong merge)


def test_cluster_sameas_ignores_singletons():
    assert E._cluster_sameas([], [], {"Q1": 9}) == {}


# ── R2 canonical_id waterfall ─────────────────────────────────────────────────

def test_compute_canonical_id_passthrough_wikidata():
    assert E._compute_canonical_id("Q1782705", None, "anything", {}) == "Q1782705"


def test_compute_canonical_id_resolves_non_wikidata_via_index():
    wi = {"the great wave off kanagawa~Q5599": "Q1782705"}
    assert E._compute_canonical_id(None, "Q5599", "The Great Wave off Kanagawa", wi) == "Q1782705"


def test_compute_canonical_id_unresolved_is_none():
    wi = {"the great wave off kanagawa~Q5599": "Q1782705"}
    assert E._compute_canonical_id(None, "Q5599", "Some Unknown Title", wi) is None  # no index hit
    assert E._compute_canonical_id(None, None, "The Great Wave off Kanagawa", wi) is None  # no artist
    assert E._compute_canonical_id(None, "Q5599", None, wi) is None  # no title


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
