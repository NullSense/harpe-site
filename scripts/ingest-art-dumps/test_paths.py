# /// script
# requires-python = ">=3.11"
# ///
"""Regression tests for paths.configure_hf_xet — the OOM guard.

On 2026-06-19 a bare ingest run set HF_XET_HIGH_PERFORMANCE=1 unconditionally,
which made hf_xet saturate all cores + buffer chunks in RAM (thousands of
concurrent transfer tasks → ~30GB → global OOM, killed the desktop). High-perf
is now OPT-IN; these tests pin that contract.
"""
import paths


def test_high_perf_is_off_by_default():
    env: dict[str, str] = {}
    assert paths.configure_hf_xet(env) is False
    assert "HF_XET_HIGH_PERFORMANCE" not in env  # never forced on


def test_opt_in_toggle_enables_high_perf():
    env = {"INGEST_HF_XET_HIGH_PERF": "1"}
    assert paths.configure_hf_xet(env) is True
    assert env["HF_XET_HIGH_PERFORMANCE"] == "1"


def test_explicit_env_is_respected_verbatim():
    # Caller already chose high-perf — respect it, don't second-guess.
    env = {"HF_XET_HIGH_PERFORMANCE": "1"}
    assert paths.configure_hf_xet(env) is True
    # Caller explicitly disabled it — must stay off even with the toggle present.
    env = {"HF_XET_HIGH_PERFORMANCE": "0", "INGEST_HF_XET_HIGH_PERF": "1"}
    assert paths.configure_hf_xet(env) is False
    assert env["HF_XET_HIGH_PERFORMANCE"] == "0"


if __name__ == "__main__":
    test_high_perf_is_off_by_default()
    test_opt_in_toggle_enables_high_perf()
    test_explicit_env_is_respected_verbatim()
    print("ok")
