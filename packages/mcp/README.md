# @harpe/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
[Harpe](https://harpe-site.vercel.app)'s art engine to LLM agents: federated +
dump-backed search across ~20 open museum/heritage collections, plus the Wikidata
knowledge graph (artist & subject pages, QID resolution).

It's a thin wrapper over `@harpe/sources` — the **same** search/dedup/ranking and
knowledge-graph orchestration the website uses, so results never fork.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `search_art` | `query`, `max?` | ranked, deduped public-domain works (image URLs + Wikidata `wikidataId`/`artistId`/`depicts`) |
| `artist` | `qid` (Q…) | the artist node + their works from the deep index |
| `subject` | `qid` (Q…) | the subject node + works that depict it (P180) |
| `resolve` | `query` | `{ kind: "subject", qid }` or `null` — turn a name into a QID |
| `item` | `id` | a single work by its stable Harpe id (e.g. `met-436535`, `commons-12345`) |

## Run it

Zero-config — defaults `HARPE_DUMP_DATASET` to the public HF dataset, so the dump
deep-index and knowledge graph work out of the box (no keys, no secrets):

```bash
# Register in Claude Code
claude mcp add harpe -- npx -y @harpe/mcp

# Or run directly (stdio)
npx -y @harpe/mcp
```

## Environment (all optional)

- `HARPE_DUMP_DATASET` — HF dataset for the dump deep-index (default `NullSense/harpe-art`).
- Per-source API keys / `UPSTASH_*` — only needed for keyed sources or shared-cache deployments;
  the keyless live sources + the public dump work without them.
