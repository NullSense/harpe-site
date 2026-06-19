"""Durable, machine-local cache dir for ingest/enrich checkpoints.

`/tmp` is wiped by a reboot (and never shared across machines), so checkpoints kept
there force a full recompute of the expensive enrichment passes (the ~12-min P460
same-as pass, the work-entity harvest) every time. Keeping them under ~/.cache makes
re-runs RESUME instead of recompute — the whole point of checkpointing. Override the
location with HARPE_CACHE_DIR (e.g. for tests or CI).
"""
import os


def cache_dir() -> str:
    d = os.environ.get("HARPE_CACHE_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "harpe-ingest")
    os.makedirs(d, exist_ok=True)
    return d


def cache_path(name: str) -> str:
    return os.path.join(cache_dir(), name)
