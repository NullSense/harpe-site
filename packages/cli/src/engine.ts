/**
 * Download engine — ported from harpe/engine.py. The filename / folder / kind
 * decision is a pure, tested function (`decideFile`); `fetchImages` is the thin
 * I/O wrapper that streams each URL to the chosen path.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import {
  displayName, extFromContentType, kindForExt, MEDIA_EXT,
  type GroupMode, type MediaKind,
} from '@harpe/core';
import { dirs as DEFAULT_DIRS, UA } from './config.js';

/** "https://host/" for use as a default Referer. */
export function origin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return url;
  }
}

/** Filesystem-safe filename/folder stem from arbitrary text (tweet/author). */
export function sanitizeStem(s: string | undefined, limit = 80): string {
  let out = (s ?? '').trim().replace(/\s+/g, ' ');
  out = out.replace(/[\\/:*?"<>|]+/g, ''); // illegal on common filesystems
  out = out.replace(/[^\w.\- ]+/g, '_'); // tame the rest
  return out.replace(/^[. _]+|[. _]+$/g, '').slice(0, limit);
}

/** Where to nest a download: by site (default), author, both, or flat. */
export function groupSubpath(group: GroupMode, host: string, author?: string): string {
  const a = sanitizeStem(author, 60);
  if (group === 'none') return '';
  if (group === 'author') return a || host;
  if (group === 'both') return a ? `${a}/${host}` : host;
  return host; // "site"
}

function expand(p: string): string {
  let s = p.trim();
  if (s.startsWith('~')) s = homedir() + s.slice(1);
  return s.replace(/\$(\w+)|\$\{(\w+)\}/g, (_m, a, b) => process.env[a || b] ?? '');
}

/** Resolve per-kind roots, expanding ~/$VARS, falling back to defaults. */
export function rootsFrom(roots?: Partial<Record<MediaKind, string>>): Record<MediaKind, string> {
  const out: Record<MediaKind, string> = { image: DEFAULT_DIRS.image, video: DEFAULT_DIRS.video, audio: DEFAULT_DIRS.audio };
  if (roots) {
    for (const kind of ['image', 'video', 'audio'] as const) {
      const v = roots[kind];
      if (typeof v === 'string' && v.trim()) out[kind] = expand(v);
    }
  }
  return out;
}

export interface FileDecision {
  dir: string;
  name: string;
  kind: MediaKind;
}

/**
 * Decide the destination dir, filename and media kind for one URL — from the
 * caller hint, the response Content-Type, and the URL (in that order). Pure.
 */
export function decideFile(opts: {
  url: string;
  host: string;
  contentType?: string | null;
  suggested?: string;
  author?: string;
  group?: GroupMode;
  roots?: Record<MediaKind, string>;
  dest?: string;
}): FileDecision {
  const { url, host, contentType, suggested, author, group = 'site', dest } = opts;
  const roots = opts.roots ?? rootsFrom();
  const urlName = displayName(url);
  const ctExt = extFromContentType(contentType);

  // Stem: prefer a descriptive caller name, else the URL basename (sans media ext).
  let stem = suggested ? sanitizeStem(suggested) : '';
  if (!stem) {
    stem = urlName;
    for (const e of MEDIA_EXT) {
      if (stem.toLowerCase().endsWith(e)) { stem = stem.slice(0, -e.length); break; }
    }
  }
  // Extension: Content-Type wins; else the URL's real media ext; else .jpg.
  const urlExt = extname(urlName);
  const ext = ctExt || (MEDIA_EXT.includes(urlExt.toLowerCase()) ? urlExt : '.jpg');
  const name = stem + ext;
  const kind = kindForExt(ext);

  const dir = dest ?? (() => {
    const sub = groupSubpath(group, host, author);
    return sub ? join(roots[kind], sub) : roots[kind];
  })();
  return { dir, name, kind };
}

export interface FetchResult {
  url: string;
  ok: boolean;
  path?: string;
  kind?: MediaKind;
  error?: string;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Disambiguate a path that already exists with an HHMMSS suffix. */
async function uniquePath(path: string): Promise<string> {
  if (!(await exists(path))) return path;
  const ext = extname(path);
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  return path.slice(0, -ext.length || undefined) + `-${stamp}` + ext;
}

/**
 * Download a list of media URLs. One result per URL: {url, ok, path?, kind?|error?}.
 * Files land in the type-appropriate root (or per-type `roots`, or a single
 * `dest`), nested per `group`. `items` maps url → {name, author} for readable
 * filenames; the saved extension is corrected from the Content-Type.
 */
export async function fetchImages(
  urls: string[],
  opts: {
    referer?: string;
    dest?: string;
    items?: Record<string, { name?: string; author?: string }>;
    group?: GroupMode;
    roots?: Partial<Record<MediaKind, string>>;
  } = {},
): Promise<FetchResult[]> {
  const typed = rootsFrom(opts.roots);
  const items = opts.items ?? {};
  const results: FetchResult[] = [];
  for (const url of urls) {
    let host = 'harpe';
    try { host = new URL(opts.referer || url).host || 'harpe'; } catch { /* keep default */ }
    const meta = items[url] ?? {};
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: opts.referer || origin(url) },
        redirect: 'follow',
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const decision = decideFile({
        url, host, contentType: res.headers.get('content-type'),
        suggested: meta.name, author: meta.author, group: opts.group, roots: typed, dest: opts.dest,
      });
      await mkdir(decision.dir, { recursive: true });
      const out = await uniquePath(join(decision.dir, decision.name));
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(out));
      results.push({ url, ok: true, path: out, kind: decision.kind });
    } catch (e) {
      results.push({ url, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
