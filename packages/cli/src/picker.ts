/**
 * fzf pickers — ported from harpe/picker.py.
 * Pure TSV helpers are exported for unit-testing without spawning fzf.
 * The real pickers (pickArt / pickPage) shell out to fzf via spawnSync.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { GRAB_THUMB } from './config.js';
import type { Candidate } from './models.js';

/** Sanitise a value for use in a TSV field (replace whitespace control chars). */
function clean(s: unknown): string {
  return String(s ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ');
}

// ---------------------------------------------------------------------------
// Art picker helpers
// ---------------------------------------------------------------------------

/**
 * Build TSV lines for the art picker.
 * Fields (1-indexed, as fzf sees them):
 *   1=index  2=res  3=source  4=title  5=artist  6=date  7=spec  8=thumb  9=medium  10=desc  11=physdim
 */
export function artTsv(cands: Candidate[]): string[] {
  return cands.map((c, i) =>
    [i, c.res, c.source, c.title, c.artist, c.date, c.spec, c.thumb, c.medium, c.desc, c.physdim]
      .map(clean)
      .join('\t'),
  );
}

/**
 * Parse a single selected fzf line back to the originating Candidate.
 * Returns null when the line is empty or the index is out of range.
 */
export function parseArtSelection(line: string, cands: Candidate[]): Candidate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const index = parseInt(trimmed.split('\t')[0] ?? '', 10);
  if (!Number.isFinite(index) || index < 0 || index >= cands.length) return null;
  return cands[index] ?? null;
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
 * Returns the chosen Candidate or null if the user cancelled / fzf not found.
 */
export function pickArt(cands: Candidate[]): Candidate | null {
  if (!cands.length) return null;
  const lines = artTsv(cands);
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
  return parseArtSelection(sel[0] ?? '', cands);
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
