/**
 * Filename slugs, captions, lossless metadata embedding, and the resolution cap.
 * Ported from harpe/metadata.py.
 *
 * Pure functions (buildSlug, captions, sidecarText) are unit-testable without
 * subprocesses.  The I/O functions (imageRes, capImage, embed, writeSidecar)
 * shell out to exiftool / exiv2 / magick via node:child_process.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { MAXPX } from './config.js';
import type { Candidate } from './models.js';
import { sourceUrl } from './models.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Return [displayName, artist, year] tuple.  Drops nationality/life-date
 * suffixes like "(Dutch, 1853–1890)" from the artist field.
 */
export function nameParts(c: Candidate): [string, string, string] {
  const artist = (c.artist || '').replace(/\s*\(.*\)$/, '');
  const ym = /\d{3,4}/.exec(c.date || '');
  const year = ym ? ym[0] : '';
  let name = c.title || 'artwork';
  if (artist) name = `${artist} - ${c.title}`;
  if (year) name = `${name} (${year})`;
  name = `${name} [${c.source}]`;
  return [name, artist, year];
}

/**
 * Filesystem-safe filename slug derived from the candidate's display name.
 * Strips path-hostile chars, control chars, and collapses whitespace.
 * Max 150 chars. Falls back to "artwork".  Pure.
 */
export function buildSlug(c: Candidate): string {
  const [name] = nameParts(c);
  let slug = name.replace(/[/\\:*?"<>|]+/g, ' ');
  slug = slug.replace(/[\x00-\x1f]/g, '');
  slug = slug.replace(/\s+/g, ' ').trim().slice(0, 150);
  return slug || 'artwork';
}

/**
 * Build the caption line and body block for an image.  Pure.
 * caption: "Artist — Title (year)"
 * body:    medium\nphysdim\nres · source\n\ndesc
 */
export function captions(c: Candidate, res: string): { caption: string; body: string } {
  const [, artist, year] = nameParts(c);
  let caption = c.title;
  if (artist) caption = `${artist} — ${c.title}`; // em-dash
  if (year) caption = `${caption} (${year})`;
  const parts = [c.medium, c.physdim].filter(Boolean);
  let body = parts.join('\n');
  const line = `${res} · ${c.source}`; // middle dot
  body = body ? `${body}\n${line}` : line;
  if (c.desc) body = `${body}\n\n${c.desc}`;
  return { caption, body };
}

/**
 * Build the full sidecar text (lines) without touching the filesystem.  Pure.
 * Used by writeSidecar and unit-testable independently.
 */
export function sidecarText(c: Candidate, res: string): string {
  const lines: string[] = [`Title: ${c.title}`];
  if (c.artist) lines.push(`Artist: ${c.artist}`);
  if (c.date) lines.push(`Date: ${c.date}`);
  if (c.medium) lines.push(`Medium: ${c.medium}`);
  if (c.physdim) lines.push(`Dimensions: ${c.physdim}`);
  lines.push(`Resolution: ${res}`, `Source: ${c.source}`, `Source URL: ${sourceUrl(c)}`);
  if (c.desc) lines.push('', c.desc);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Subprocess wrappers
// ---------------------------------------------------------------------------

/** Try `identify` (ImageMagick 6) then `magick identify` (IM7). Returns '' on failure. */
export function imageRes(path: string): string {
  for (const cmd of [['identify', '-format', '%wx%h', `${path}[0]`],
                     ['magick', 'identify', '-format', '%wx%h', `${path}[0]`]]) {
    try {
      const out = execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const trimmed = out.trim();
      if (trimmed) return trimmed;
    } catch {
      // try next
    }
  }
  return '';
}

/**
 * If MAXPX > 0 and the image exceeds MAXPX on either axis, downscale it in
 * place using magick.  No-op if MAXPX === 0 or magick is not installed.
 */
export function capImage(path: string): void {
  if (!MAXPX || MAXPX <= 0) return;
  const res = imageRes(path);
  if (!res || !res.includes('x')) return;
  const [ws, hs] = res.split('x');
  const w = parseInt(ws, 10);
  const h = parseInt(hs, 10);
  if (Number.isNaN(w) || Number.isNaN(h)) return;
  if (w <= MAXPX && h <= MAXPX) return;
  spawnSync('magick', [path, '-resize', `${MAXPX}x${MAXPX}>`, path], { stdio: 'inherit' });
}

/**
 * Embed metadata into the image losslessly.  Tries exiftool first, then
 * exiv2.  Returns true if at least one tool succeeded.
 *
 * exiftool tags written:
 *   IFD0:ImageDescription, IFD0:Artist
 *   XMP-dc:Title, XMP-dc:Creator, XMP-dc:Description, XMP-dc:Date,
 *   XMP-dc:Format, XMP-dc:Source
 *
 * exiv2 tags written:
 *   Exif.Image.ImageDescription, Exif.Image.Artist (when present)
 *   Xmp.dc.title, Xmp.dc.creator, Xmp.dc.description, Xmp.dc.date,
 *   Xmp.dc.format, Xmp.dc.extent, Xmp.dc.source
 */
export function embed(path: string, c: Candidate, caption: string): boolean {
  const [, artist] = nameParts(c);
  const src = sourceUrl(c);

  // --- exiftool ---
  try {
    const result = spawnSync('exiftool', [
      '-overwrite_original', '-q', '-m',
      `-IFD0:ImageDescription=${caption}`,
      `-IFD0:Artist=${artist}`,
      `-XMP-dc:Title=${c.title}`,
      `-XMP-dc:Creator=${artist}`,
      `-XMP-dc:Description=${c.desc}`,
      `-XMP-dc:Date=${c.date}`,
      `-XMP-dc:Format=${c.medium}`,
      `-XMP-dc:Source=${src}`,
      path,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    if (result.status === 0) return true;
  } catch {
    // fall through to exiv2
  }

  // --- exiv2 ---
  try {
    const m: string[] = [
      `-Mset Exif.Image.ImageDescription ${caption}`,
    ];
    if (artist) m.push(`-Mset Exif.Image.Artist ${artist}`);
    m.push(`-Mset Xmp.dc.title ${c.title}`);
    if (artist) m.push(`-Mset Xmp.dc.creator ${artist}`);
    if (c.desc) m.push(`-Mset Xmp.dc.description ${c.desc}`);
    if (c.date) m.push(`-Mset Xmp.dc.date ${c.date}`);
    if (c.medium) m.push(`-Mset Xmp.dc.format ${c.medium}`);
    if (c.physdim) m.push(`-Mset Xmp.dc.extent ${c.physdim}`);
    m.push(`-Mset Xmp.dc.source ${src}`);
    const result = spawnSync('exiv2', [...m, path], { stdio: ['ignore', 'ignore', 'ignore'] });
    if (result.status === 0) return true;
  } catch {
    // both tools failed
  }

  return false;
}

/**
 * Write a plain-text sidecar file `<path>.txt` as a fallback when no metadata
 * embedder is installed.
 */
export function writeSidecar(path: string, c: Candidate, res: string): void {
  const sidecarPath = `${path}.txt`;
  writeFileSync(sidecarPath, sidecarText(c, res), 'utf8');
}
