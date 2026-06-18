/**
 * fzf pickers — ported from harpe/picker.py.
 * Updated to use ArtItem instead of Candidate (monorepo-phase1 refactor).
 *
 * Pure TSV helpers are exported for unit-testing without spawning fzf.
 * The real pickers (pickArt / pickPage) shell out to fzf via spawnSync.
 *
 * Candidate field → ArtItem field mapping used in the TSV:
 *   res     → artRes(it)   derived from width×height or 'WxH'
 *   source  → it.source
 *   title   → it.title
 *   artist  → it.artist
 *   date    → it.date ?? ''
 *   spec    → artSpec(it)  fullUrl (the download URL)
 *   thumb   → it.thumbUrl
 *   medium  → it.medium ?? ''
 *   desc    → it.description ?? ''
 *   physdim → it.dimensions
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { GRAB_THUMB } from './config.js';
import type { ArtItem } from '@harpe/core';

/** Sanitise a value for use in a TSV field (replace whitespace control chars). */
function clean(s: unknown): string {
  return String(s ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ');
}

// ---------------------------------------------------------------------------
// ArtItem → display helpers (derive Candidate-equivalent fields)
// ---------------------------------------------------------------------------

/** Resolution string: "WxH" from pixel dims, or empty string. */
export function artRes(it: ArtItem): string {
  if (it.width && it.height) return `${it.width}x${it.height}`;
  return '';
}

/**
 * Spec: the URL to fetch for download. For dezoomify targets, the source
 * URL (e.g. museum page) is used; for direct images, the fullUrl.
 * Since @harpe/sources adapters no longer return IIIF manifests in the search
 * flow, this is always the fullUrl.
 */
export function artSpec(it: ArtItem): string {
  return it.fullUrl;
}

// ---------------------------------------------------------------------------
// Art picker helpers
// ---------------------------------------------------------------------------

/**
 * Build TSV lines for the art picker.
 * Fields (1-indexed, as fzf sees them):
 *   1=index  2=res  3=source  4=title  5=artist  6=date  7=spec  8=thumb  9=medium  10=desc  11=physdim
 */
export function artTsv(items: ArtItem[]): string[] {
  return items.map((it, i) =>
    [i, artRes(it), it.source, it.title, it.artist, it.date ?? '', artSpec(it), it.thumbUrl, it.medium ?? '', it.description ?? '', it.dimensions]
      .map(clean)
      .join('\t'),
  );
}

/**
 * Parse a single selected fzf line back to the originating ArtItem.
 * Returns null when the line is empty or the index is out of range.
 */
export function parseArtSelection(line: string, items: ArtItem[]): ArtItem | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const index = parseInt(trimmed.split('\t')[0] ?? '', 10);
  if (!Number.isFinite(index) || index < 0 || index >= items.length) return null;
  return items[index] ?? null;
}

// ---------------------------------------------------------------------------
// Page picker helpers
// ---------------------------------------------------------------------------

export interface PageRow {
  dim: string;
  url: string;
  name: string;
}

/**
 * Build TSV lines for the page picker.
 * Fields (1-indexed): 1=dim  2=url  3=name
 */
export function pageTsv(rows: PageRow[]): string[] {
  return rows.map((r) => [r.dim, r.url, r.name].map(clean).join('\t'));
}

/** Parse one or more fzf-selected lines back to {url, name} objects. */
export function parsePageSelection(lines: string[]): Array<{ url: string; name: string }> {
  const out: Array<{ url: string; name: string }> = [];
  for (const ln of lines) {
    const parts = ln.split('\t');
    if (parts.length >= 2) {
      out.push({ url: parts[1] ?? '', name: parts[2] ?? '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// fzf runner (internal)
// ---------------------------------------------------------------------------

function runFzf(lines: string[], args: string[]): string[] {
  const result = spawnSync('fzf', args, {
    input: lines.join('\n'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split('\n').filter((ln) => ln.trim());
}

// ---------------------------------------------------------------------------
// Public pickers
// ---------------------------------------------------------------------------

/**
 * Single-select art picker.
 * Returns the chosen ArtItem or null if the user cancelled / fzf not found.
 */
export function pickArt(items: ArtItem[]): ArtItem | null {
  if (!items.length) return null;
  const lines = artTsv(items);
  const hasThumb = existsSync(GRAB_THUMB);

  const args: string[] = [
    '--delimiter=\t',
    '--with-nth=2,3,4,5,6',
    '--no-multi',
    '--height=90%',
    '--reverse',
  ];
  if (hasThumb) {
    args.push(`--preview=${GRAB_THUMB} {8} {2} · {3} · {4} {5} {6} · {9}`);
  }

  const sel = runFzf(lines, args);
  if (!sel.length) return null;
  return parseArtSelection(sel[0] ?? '', items);
}

/**
 * Multi-select page image picker.
 * Returns the selected rows as {url, name}; empty array if cancelled.
 */
export function pickPage(rows: PageRow[]): Array<{ url: string; name: string }> {
  if (!rows.length) return [];
  const lines = pageTsv(rows);
  const hasThumb = existsSync(GRAB_THUMB);

  const args: string[] = [
    '--delimiter=\t',
    '--with-nth=1,3',
    '--multi',
    '--bind=ctrl-a:select-all,ctrl-t:toggle-all',
    '--height=90%',
    '--reverse',
  ];
  if (hasThumb) {
    args.push(`--preview=${GRAB_THUMB} {2} {1} · {3}`);
  }

  const sel = runFzf(lines, args);
  return parsePageSelection(sel);
}
