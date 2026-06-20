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


def configure_hf_xet(env: dict | None = None) -> bool:
    """Decide whether hf_xet runs in high-performance mode. Returns True if on.

    HF_XET_HIGH_PERFORMANCE=1 makes hf_xet saturate ALL CPU cores and buffer many
    chunks in RAM — it fans out into thousands of concurrent transfer tasks. Forced
    on unconditionally, that OOM-killed the whole desktop on 2026-06-19 while
    uploading the ~1GB FTS index (a ~30GB python3 → global OOM). So it is now
    OPT-IN. Precedence:
      1. HF_XET_HIGH_PERFORMANCE already set → respect it verbatim (caller's choice).
      2. INGEST_HF_XET_HIGH_PERF == "1"      → enable (ideally only inside the
         `heavy` cgroup cap — see ~/.local/bin/heavy).
      3. otherwise                           → leave hf_xet on its safe defaults
         (~8 workers, 16 concurrent range-gets).
    """
    env = os.environ if env is None else env
    existing = env.get("HF_XET_HIGH_PERFORMANCE")
    if existing is not None:
        return existing == "1"
    if env.get("INGEST_HF_XET_HIGH_PERF") == "1":
        env["HF_XET_HIGH_PERFORMANCE"] = "1"
        return True
    return False
