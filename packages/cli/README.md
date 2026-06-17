# @harpe/cli

The Harpe engine + CLI, in TypeScript, built on [`@harpe/core`](../core).

> **Status: work in progress.** This is the in-progress port of the Python
> `harpe` engine onto the shared core. The Python `harpe` remains the shipping
> engine until this reaches parity — do not remove it yet.

## Ported so far (tested)

| Module | What | Source of truth |
|---|---|---|
| `config.ts` | paths, UAs, env knobs, `ytdlpExtraArgs()` | `harpe/config.py` |
| `backends.ts` | yt-dlp / gallery-dl / dezoomify-rs wrappers + pure arg builders | `harpe/backends.py` |
| `routing.ts` | URL classification + `cleanTitle` | `harpe/routing.py` (pure parts) |
| `protocol.ts` | native-messaging framing (4-byte LE + JSON) + `capReply`, typed by `@harpe/core` contract | `harpe/nativehost.py` |
| `extract.ts` | static-HTML image extraction (`collect`/`select`/`wmOriginal`/`sizeHint`) | `harpe/extract.py` (pure parts) |
| `engine.ts` | download decision (`decideFile`/`sanitizeStem`/`groupSubpath`/`rootsFrom`, pure + tested) + `fetchImages` (I/O) | `harpe/engine.py` |

Media-kind classification (`MEDIA_EXT`, `kindForExt`, `extFromContentType`,
`displayName`) lives in `@harpe/core` (shared with the site).

Tests are ported from the Python `tests/` (TDD): `routing`, `backends`,
`protocol`, `extract`, `engine`.

## Remaining to reach parity

- native-host **handlers** + run loop (ping/open/pick/grab → engine) ← `nativehost.py`
- `installhost.ts` (manifests + Windows registry) ← `installhost.py`
- museum `sources.ts` — best shared into `@harpe/core` so the site + CLI use one
  implementation ← `sources.py` / the site's `art.ts` (kills duplication #2)
- network bits: dimension probing (`extract.page_images`), `enumerate_images`,
  `query_from_url` ← `extract.py` / `routing.py`
- picker, metadata (EXIF/XMP), reverse-image ← `picker.py` / `metadata.py` / `reverse.py`
- `cli.ts` entry + `bin`

Each lands with its Python tests ported first.
