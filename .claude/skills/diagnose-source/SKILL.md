---
name: diagnose-source
description: Use when a Harpe art source is failing — the live site returns no/partial results, the Monitor workflow filed a tracking issue, search_art warns "all dump sources failed" or "fetch failed", or the user names a flaky source (Met, Commons, AIC, Wikidata, ...). Root-causes the failure and proposes/implements the minimal fix with a regression test. This is the LOCAL twin of .github/workflows/autoheal.yml — same recipe, no GitHub app or API key needed.
---

# Diagnose a failing art source

Harpe federates ~20 live museum/heritage sources. The dominant operational
failure is an upstream change (schema, hotlink rules, IIIF host, dump URL)
silently breaking one adapter. This skill turns the `autoheal.yml` prompt into
a loop you can run locally.

**Two failure signatures, two root-cause paths — classify first:**

| Warning seen | Means | Look here first |
|---|---|---|
| `fetch failed` (live sources: Commons, WikiArt, V&A, Nasjonalmuseet, DigitalNZ) | the adapter's HTTP call threw — upstream down, host blocking, network, or URL/schema change | the source's `fetch*` in `packages/sources/src/adapters.ts` + its helpers |
| `all dump sources failed` (Met, AIC, Cleveland, NGA, Smithsonian, Wikidata, ...) | the dump/deep-index couldn't load — stale/missing dump URL, parquet/index unavailable, or no network for the dump host | the dump fetch path (`fetchDumpSearch` / dump loaders) + `harpe-art.parquet` freshness |

> Before assuming a code defect: if **every** source fails at once (as in a
> sandbox with no egress), the cause is environmental (no network / missing
> index), **not** an adapter bug. Say so and stop — don't "fix" working code.

## Checklist (create one todo per step)

1. **Reproduce against live.** Run the synthetic monitor — it hits the real
   deployed endpoints and real upstreams and writes `monitor-results.json`:
   ```bash
   node tests/live/monitor.mjs   # or: pnpm run monitor
   ```
   To probe one source in isolation, run its live test:
   ```bash
   RUN_LIVE=1 pnpm exec vitest run --project live packages/sources/src/sources.live.test.ts
   ```

2. **Read the diagnostics.** Open `monitor-results.json`; list every check with
   `ok:false`, its `err`, and whether it's `critical`. Map each failing check to
   its source adapter.

3. **Classify** each failure using the table above (`fetch failed` vs
   `all dump sources failed`). Confirm by calling the source directly (a real
   request to the upstream endpoint) and inspecting the response shape — don't
   guess at the schema.

4. **Root-cause** in `packages/sources/src/adapters.ts` (the `fetch<Name>`
   function) or the dump path. Common causes: response schema changed, a field
   moved/renamed, an image host started hotlink-blocking, an IIIF base changed,
   a dump/endpoint URL 404s or moved.

5. **Implement the smallest correct fix.** Edit only the failing adapter/path.
   Do not touch secrets, workflows, unrelated sources, or the generated parquet.
   Keep the `ArtItem` contract intact (see `docs/ADDING_SOURCES.md`).

6. **Add a regression test** that captures the break — a unit test in the
   matching `packages/sources/src/*.test.ts` asserting the parse/mapping against
   a saved fixture of the new response shape (offline; not a `.live.test.ts`).

7. **Gate green.** Run the offline tests for the package, then the full check:
   ```bash
   pnpm exec vitest run --project default packages/sources
   pnpm run verify
   ```

8. **Report.** Summarize: which source, the signature, the upstream change, the
   one-line fix, and the new test. If it's a transient upstream outage rather
   than a code defect, recommend opening **no** change and note it instead —
   exactly as autoheal does.

## Coordination

If another agent is mid-edit in `packages/sources` or `src/lib/server`, stop at
step 4 (diagnosis only) and hand off the root cause + proposed patch rather than
editing a moving target.
