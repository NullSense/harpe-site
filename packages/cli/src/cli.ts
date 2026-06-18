#!/usr/bin/env node
/**
 * Harpe CLI entry — ported from harpe/cli.py.
 *
 * Modes (mutually exclusive): -v video, -A audio, -i image, -p page,
 * -a art (dezoomify), -r reverse, -s search, -F fetch; default = auto (route by
 * URL). `--json` emits machine-readable output instead of driving fzf.
 * `--native-host` runs the native-messaging loop for the browser extension;
 * `install-host` / `uninstall-host` register it.
 *
 * The flows mirror cli.py: this file is only orchestration — every primitive
 * lives in a tested module (engine/sources/extract/routing/backends/picker/
 * metadata/reverse/notify/installhost/nativehost).
 */
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parse as parseHtml } from 'node-html-parser';

import { dirs, ART_DIR, MAXPX, GRAB_THUMB, UA } from './config.js';
import { video, audio, gallery, dezoomify, slugFromUrl } from './backends.js';
import { fetchImages, scanPage, enumerateImages, type FetchResult } from './engine.js';
import { isArtUrl, isReferencePage, hasVideo, queryFromUrl } from './routing.js';
import { searchArt } from './sources.js';
import type { ArtItem } from '@harpe/core';
import { pickArt, pickPage } from './picker.js';
import { artSourceUrl, buildSlug, captions, imageRes, capImage, embed, writeSidecar } from './metadata.js';
import { reverseSearch } from './reverse.js';
import { pageDescription } from './describe.js';
import { send as notify } from './notify.js';
import { run as nativeHostRun } from './nativehost.js';
import { install as installHost, uninstall as uninstallHost, autoRegisterOnce } from './installhost.js';

const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif|tiff?|bmp|avif|svg)(?:[?#]|$)/i;

// ─── small helpers ───────────────────────────────────────────────────────────

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Positional args that aren't flags; `["-"]` means read URLs from stdin. */
export function readUrls(args: string[]): string[] {
  if (args.length === 1 && args[0] === '-') {
    const data = spawnSync('cat', [], { encoding: 'utf8' }).stdout ?? '';
    return data.split(/\s+/).filter(Boolean);
  }
  return args.filter((a) => !a.startsWith('-'));
}

export type Mode =
  | 'auto' | 'video' | 'audio' | 'image' | 'page' | 'art' | 'reverse' | 'search' | 'fetch';

export interface ParsedArgs {
  mode: Mode;
  json: boolean;
  referer?: string;
  dest?: string;
  urls: string[];
}

const MODE_FLAGS: Record<string, Mode> = {
  '-v': 'video', '--video': 'video',
  '-A': 'audio', '--audio': 'audio',
  '-i': 'image', '--image': 'image',
  '-p': 'page', '--page': 'page',
  '-a': 'art', '--art': 'art',
  '-r': 'reverse', '--reverse': 'reverse',
  '-s': 'search', '--search': 'search',
  '-F': 'fetch', '--fetch': 'fetch',
};

/** Pure arg parser (mutually-exclusive mode flags + --json/--referer/--dest). */
export function parseArgs(argv: string[]): ParsedArgs {
  let mode: Mode = 'auto';
  let json = false;
  let referer: string | undefined;
  let dest: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in MODE_FLAGS) mode = MODE_FLAGS[a];
    else if (a === '--json') json = true;
    else if (a === '--referer') referer = argv[++i];
    else if (a === '--dest') dest = argv[++i];
    else positional.push(a);
  }
  return { mode, json, referer, dest, urls: positional.filter((a) => !a.startsWith('-')) };
}

function die(msg: string): never {
  process.stderr.write(`harpe: ${msg}\n`);
  throw new ExitError(1);
}

class ExitError extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawnSync(cmd, [url], { stdio: 'ignore' }); } catch { /* best effort */ }
}

/** fzf one/multi select over pre-built lines; null/[] when nothing chosen. */
function fzf(lines: string[], args: string[]): string[] {
  const r = spawnSync('fzf', args, { input: lines.join('\n'), encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function clipboard(): string {
  const cmd = process.platform === 'darwin' ? ['pbpaste'] : ['wl-paste', '-n'];
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
    return (r.stdout ?? '').trim();
  } catch { return ''; }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ─── output ──────────────────────────────────────────────────────────────────

function saveAndNotify(results: FetchResult[]): number {
  let last: FetchResult | undefined;
  for (const r of results) {
    if (r.ok && r.path) { process.stdout.write(`saved → ${r.path}\n`); last = r; }
    else process.stderr.write(`failed: ${r.url} (${r.error ?? 'error'})\n`);
  }
  if (last?.path) notify(last.path, 'Saved', last.path);
  return results.some((r) => r.ok) ? 0 : 1;
}

// ─── flows ───────────────────────────────────────────────────────────────────

async function flowPage(page: string, json: boolean): Promise<number> {
  const rows = await scanPage(page);
  if (json) { process.stdout.write(JSON.stringify(rows) + '\n'); return 0; }
  if (!rows.length) { process.stderr.write('no images found\n'); return 1; }
  const chosen = pickPage(rows.map((r) => ({ dim: r.dim, url: r.url, name: r.name })));
  if (!chosen.length) return 1;
  const items = Object.fromEntries(chosen.map((c) => [c.url, { name: c.name }]));
  const results = await fetchImages(chosen.map((c) => c.url), { referer: page, items });
  return saveAndNotify(results);
}

async function downloadArtItem(it: ArtItem): Promise<string | null> {
  const url = artSourceUrl(it);
  await mkdir(ART_DIR, { recursive: true });
  // Dezoomify for IIIF manifests (URL ends in .json or /info.json).
  // In practice, server-side adapters emit direct image URLs; this path handles
  // any custom IIIF manifest URLs passed through the search flow.
  if (/\/(info\.json|manifest\.json?)$/i.test(url) || url.endsWith('.json')) {
    const out = join(ART_DIR, `${buildSlug(it)}.jpg`);
    const code = await dezoomify(url, out, MAXPX);
    return code === 0 ? out : null;
  }
  const [res] = await fetchImages([url], {
    roots: { image: ART_DIR }, group: 'none', items: { [url]: { name: buildSlug(it) } },
  });
  return res?.ok ? (res.path ?? null) : null;
}

async function searchInteractive(query: string, pageUrl?: string): Promise<number> {
  const items = await searchArt(query);
  if (!items.length) { process.stderr.write('no results\n'); return 1; }
  const it = pickArt(items);
  if (!it) return 1;
  const path = await downloadArtItem(it);
  if (!path) { process.stderr.write(`failed: ${artSourceUrl(it)}\n`); return 1; }
  if (MAXPX > 0) capImage(path);
  const res = imageRes(path);
  // If no description and we have a page URL, fetch from the page.
  // ArtItem is immutable so we keep the fetched description locally.
  const desc = it.description || (pageUrl ? await pageDescription(pageUrl) : undefined);
  const itWithDesc: ArtItem = desc && !it.description ? { ...it, description: desc } : it;
  const { caption, body } = captions(itWithDesc, res);
  if (!embed(path, itWithDesc, caption)) writeSidecar(path, itWithDesc, res);
  process.stdout.write(`saved → ${path}\n`);
  notify(path, caption, body);
  return 0;
}

async function flowSearch(args: string[], json: boolean): Promise<number> {
  let query = args.join(' ').trim();
  let pageUrl: string | undefined;
  if (args.length === 1 && isUrl(args[0])) {
    pageUrl = args[0];
    query = await queryFromUrl(pageUrl);
    if (!query) die('could not derive a search query from that URL');
  }
  if (!query) die('nothing to search for');
  if (json) { process.stdout.write(JSON.stringify(await searchArt(query)) + '\n'); return 0; }
  return searchInteractive(query, pageUrl);
}

async function flowFetch(args: string[], json: boolean, referer?: string, dest?: string): Promise<number> {
  const urls = readUrls(args);
  if (!urls.length) die('no URLs to fetch');
  const results = await fetchImages(urls, { referer, dest });
  if (json) { process.stdout.write(JSON.stringify(results) + '\n'); return 0; }
  return saveAndNotify(results);
}

async function resolveImageUrl(input: string): Promise<string | null> {
  if (IMAGE_URL_RE.test(input)) return input;
  try {
    const res = await fetch(input, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const og = parseHtml(await res.text())
      .querySelector('meta[property="og:image"]')?.getAttribute('content');
    return og || null;
  } catch { return null; }
}

async function flowReverse(input: string, json: boolean): Promise<number> {
  const img = await resolveImageUrl(input);
  if (!img) die('no image found at that URL');
  const rows = await reverseSearch(img);
  if (json) { process.stdout.write(JSON.stringify(rows) + '\n'); return 0; }
  if (!rows.length) { openUrl(`https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(img)}`); return 0; }
  const preview = existsSync(GRAB_THUMB) ? [`--preview=${GRAB_THUMB} {5} {1} · {2} · {3}`] : [];
  const [picked] = fzf(rows, ['--delimiter=\t', '--with-nth=1,2,3', '--no-multi', '--height=90%', '--reverse', ...preview]);
  if (!picked) return 1;
  const srcUrl = picked.split('\t')[3];
  if (!srcUrl) return 1;
  return gallery([srcUrl], dirs.image);
}

async function flowArt(urls: string[]): Promise<number> {
  await mkdir(ART_DIR, { recursive: true });
  let ok = 0;
  for (const url of urls) {
    const out = join(ART_DIR, `${slugFromUrl(url)}.jpg`);
    const code = await dezoomify(url, out, MAXPX);
    if (code === 0) { process.stdout.write(`saved → ${out}\n`); ok++; }
    else process.stderr.write(`failed: ${url}\n`);
  }
  return ok ? 0 : 1;
}

async function flowAutoImage(page: string): Promise<number> {
  const rows = await enumerateImages(page);
  if (rows.length === 0) return gallery([page], dirs.image);
  if (rows.length === 1) {
    const results = await fetchImages([rows[0].url], { referer: page, items: { [rows[0].url]: { name: rows[0].name } } });
    return saveAndNotify(results);
  }
  const chosen = pickPage(rows.map((r) => ({ dim: r.dim, url: r.url, name: r.name })));
  if (!chosen.length) return 1;
  const items = Object.fromEntries(chosen.map((c) => [c.url, { name: c.name }]));
  return saveAndNotify(await fetchImages(chosen.map((c) => c.url), { referer: page, items }));
}

async function flowAuto(urls: string[]): Promise<number> {
  let rc = 0;
  for (const url of urls) {
    if (isArtUrl(url)) rc ||= await flowArt([url]);
    else if (isReferencePage(url)) rc ||= await flowSearch([url], false);
    else if (await hasVideo(url)) rc ||= await video([url], dirs.video);
    else rc ||= await flowAutoImage(url);
  }
  return rc;
}

async function flowInteractive(): Promise<number> {
  const clip = clipboard();
  const ans = await prompt(clip ? `URL [${clip}]: ` : 'URL: ');
  const url = ans || clip;
  if (!url) return 1;
  return flowAuto([url]);
}

// ─── entry ───────────────────────────────────────────────────────────────────

const USAGE = `harpe — download art, images and video; search open museum collections.

Usage: harpe [mode] [options] <url|query…>

Modes (default: auto-detect from the URL):
  -v, --video      download video (yt-dlp)
  -A, --audio      download audio (yt-dlp -x)
  -i, --image      download a gallery (gallery-dl), falling back to a page scan
  -p, --page       scan a page and pick images to download
  -a, --art        download zoomable/IIIF art at full resolution (dezoomify)
  -s, --search     federated museum search (query, or a museum page URL)
  -r, --reverse    reverse-image search a URL/page, then download the source
  -F, --fetch      download image URLs directly (--referer, --dest)

Options:
  --json           emit JSON instead of opening the fzf picker
  --referer URL    Referer header for --fetch
  --dest DIR       destination dir for --fetch

Other:
  install-host [--chrome-id ID] [--firefox-id ID] [--all]   register the browser native host
  uninstall-host                                            remove it
  --native-host                                             run the native-messaging loop (used by the extension)
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(USAGE); return 0; }
  // Pre-parse intercepts (the browser appends args argparse would reject).
  if (argv.includes('--native-host')) return nativeHostRun();
  if (argv[0] === 'install-host' || argv[0] === 'uninstall-host') {
    if (argv[0] === 'uninstall-host') { for (const p of await uninstallHost()) process.stdout.write(`removed ${p}\n`); return 0; }
    const chrome: string[] = [];
    const firefox: string[] = [];
    let all = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--chrome-id') chrome.push(argv[++i]);
      else if (argv[i] === '--firefox-id') firefox.push(argv[++i]);
      else if (argv[i] === '--all') all = true;
    }
    for (const p of await installHost({ extraChromeIds: chrome, extraFirefoxIds: firefox, allBrowsers: all })) {
      process.stdout.write(`wrote ${p}\n`);
    }
    return 0;
  }

  // First-run: register the native host once (interactive sessions only).
  if (process.stdin.isTTY && process.stdout.isTTY) {
    try { await autoRegisterOnce(); } catch { /* best effort */ }
  }

  const a = parseArgs(argv);
  if (a.mode === 'auto' && a.urls.length === 0) return flowInteractive();

  switch (a.mode) {
    case 'video': return video(readUrls(a.urls), dirs.video);
    case 'audio': return audio(readUrls(a.urls), dirs.audio);
    case 'image': {
      const urls = readUrls(a.urls);
      const code = await gallery(urls, dirs.image);
      // gallery-dl exit 64 = unsupported URL → fall back to page scan.
      return code === 64 && urls.length === 1 ? await flowPage(urls[0], a.json) : code;
    }
    case 'page': return flowPage(a.urls[0], a.json);
    case 'art': return flowArt(readUrls(a.urls));
    case 'reverse': return flowReverse(a.urls[0], a.json);
    case 'search': return flowSearch(a.urls, a.json);
    case 'fetch': return flowFetch(a.urls, a.json, a.referer, a.dest);
    case 'auto': return flowAuto(readUrls(a.urls));
  }
}

// Run when invoked as the binary (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof ExitError) process.exit(e.code);
      process.stderr.write(`harpe: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
