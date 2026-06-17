# @harpe/cli

The Harpe engine + CLI, in TypeScript, built on [`@harpe/core`](../core).

> **Status: feature-complete port.** Every primary flow of the Python `harpe`
> engine is ported and tested. Run it with `pnpm --filter @harpe/cli build` then
> `node packages/cli/dist/cli.js …` (installed as `harpe` / `grab`). The Python
> `harpe` remains the reference until this is exercised in the wild.

## Ported so far (tested)

| Module | What | Source of truth |
|---|---|---|
| `config.ts` | paths, UAs, env knobs, `ytdlpExtraArgs()` | `harpe/config.py` |
| `backends.ts` | yt-dlp / gallery-dl / dezoomify-rs wrappers + pure arg builders | `harpe/backends.py` |
| `routing.ts` | URL classification + `cleanTitle` | `harpe/routing.py` (pure parts) |
| `protocol.ts` | native-messaging framing (4-byte LE + JSON) + `capReply`, typed by `@harpe/core` contract | `harpe/nativehost.py` |
| `extract.ts` | static-HTML image extraction (`collect`/`select`/`wmOriginal`/`sizeHint`) | `harpe/extract.py` (pure parts) |
| `engine.ts` | download decision (`decideFile`/`sanitizeStem`/`groupSubpath`/`rootsFrom`, pure + tested) + `fetchImages` (I/O) | `harpe/engine.py` |
| `nativehost.ts` | native-messaging **handlers** (ping/open/pick/grab, deps-injected → tested) + `run()` loop + desktop helpers (open folder / pick folder) | `harpe/nativehost.py` |

Media-kind classification (`MEDIA_EXT`, `kindForExt`, `extFromContentType`,
`displayName`) lives in `@harpe/core` (shared with the site).

Tests are ported from the Python `tests/` (TDD): `routing`, `backends`,
`protocol`, `extract`, `engine`.

## Now ported (tested)

| Module | What | Source of truth |
|---|---|---|
| `cli.ts` + `bin` | full entry: modes -v/-A/-i/-p/-a/-r/-s/-F + auto, `--native-host`, `install-host`/`uninstall-host`, `--json`, `--help` | `cli.py` |
| `installhost.ts` | per-OS native-messaging manifests + HKCU registry (via `reg.exe`) | `installhost.py` |
| `sources.ts` + `rank.ts` + `models.ts` | 10-source federated museum search → ranked `Candidate[]` | `sources.py`/`rank.py`/`models.py` |
| `extract.ts` (net) | `pageImages`/`probe` — Range-GET header probing with a hand-rolled PNG/JPEG/GIF/WebP dimension parser (no deps) | `extract.py` |
| `routing.ts` (net) | `queryFromUrl` (JSON-LD/og:title), `hasVideo` (yt-dlp probe) | `routing.py` |
| `engine.ts` (net) | `scanPage`, `enumerateImages` (gallery-dl → scan fallback) | `engine.py` |
| `picker.ts` | fzf art + page pickers (graceful no-thumb fallback) | `picker.py` |
| `metadata.ts` | EXIF/XMP embed (exiftool→exiv2→sidecar), `imageRes`, `capImage` | `metadata.py` |
| `notify.ts` | desktop notification + clipboard | `notify.py` |
| `describe.ts` | best-effort page prose (no `trafilatura` dep) | `describe.py` |

### Intentional differences from the Python

- **`reverse.ts`** ships the **SauceNAO** engine only (clean JSON API). The
  Python's Ascii2D/IQDB/Yandex go through `PicImageSearch`, which has no reliable
  keyless Node equivalent; they're deferred rather than scraped fragile-ly.
- **`describe.ts`** strips tags + truncates instead of pulling in `trafilatura`.

Each module landed with its Python tests ported first (TDD).
