/**
 * Filename slugs, captions, lossless metadata embedding, and the resolution cap.
 * Ported from harpe/metadata.py. Updated to use ArtItem (was Candidate).
 *
 * Candidate → ArtItem field mapping:
 *   c.artist   → it.artist
 *   c.date     → it.date ?? ''
 *   c.title    → it.title
 *   c.source   → it.source
 *   c.medium   → it.medium ?? ''
 *   c.physdim  → it.dimensions
 *   c.desc     → it.description ?? ''
 *   sourceUrl(c) → artSourceUrl(it)  (it.sourceUrl ?? it.fullUrl)
 *
 * Pure functions (buildSlug, captions, sidecarText) are unit-testable without
 * subprocesses. The I/O functions (imageRes, capImage, embed, writeSidecar)
 * shell out to exiftool / exiv2 / magick via node:child_process.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { MAXPX } from './config.js';
import type { ArtItem } from '@harpe/core';

// ---------------------------------------------------------------------------
// Source URL helper
// ---------------------------------------------------------------------------

/**
 * The canonical page URL for an ArtItem — used in sidecar files and metadata
 * embed. Prefers the explicit `sourceUrl` (museum page) over the image URL.
 */
export function artSourceUrl(it: ArtItem): string {
  return it.sourceUrl || it.fullUrl;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Return [displayName, artist, year] tuple.  Drops nationality/life-date
 * suffixes like "(Dutch, 1853–1890)" from the artist field.
 */
export function nameParts(it: ArtItem): [string, string, string] {
  const artist = (it.artist || '').replace(/\s*\(.*\)$/, '');
  const ym = /\d{3,4}/.exec(it.date || '');
  const year = ym ? ym[0] : '';
  let name = it.title || 'artwork';
  if (artist) name = `${artist} - ${it.title}`;
  if (year) name = `${name} (${year})`;
  name = `${name} [${it.source}]`;
  return [name, artist, year];
}

/**
 * Filesystem-safe filename slug derived from the item's display name.
 * Strips path-hostile chars, control chars, and collapses whitespace.
 * Max 150 chars. Falls back to "artwork".  Pure.
 */
export function buildSlug(it: ArtItem): string {
  const [name] = nameParts(it);
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
export function captions(it: ArtItem, res: string): { caption: string; body: string } {
  const [, artist, year] = nameParts(it);
  let caption = it.title;
  if (artist) caption = `${artist} — ${it.title}`; // em-dash
  if (year) caption = `${caption} (${year})`;
  const parts = [it.medium, it.dimensions].filter(Boolean);
  let body = parts.join('\n');
  const line = `${res} · ${it.source}`; // middle dot
  body = body ? `${body}\n${line}` : line;
  const desc = it.description;
  if (desc) body = `${body}\n\n${desc}`;
  return { caption, body };
}

/**
 * Build the full sidecar text (lines) without touching the filesystem.  Pure.
 * Used by writeSidecar and unit-testable independently.
 */
export function sidecarText(it: ArtItem, res: string): string {
  const lines: string[] = [`Title: ${it.title}`];
  if (it.artist) lines.push(`Artist: ${it.artist}`);
  if (it.date) lines.push(`Date: ${it.date}`);
  if (it.medium) lines.push(`Medium: ${it.medium}`);
  if (it.dimensions) lines.push(`Dimensions: ${it.dimensions}`);
  lines.push(`Resolution: ${res}`, `Source: ${it.source}`, `Source URL: ${artSourceUrl(it)}`);
  if (it.description) lines.push('', it.description);
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
export function embed(path: string, it: ArtItem, caption: string): boolean {
  const [, artist] = nameParts(it);
  const src = artSourceUrl(it);
  const desc = it.description ?? '';
  const medium = it.medium ?? '';

  // --- exiftool ---
  try {
    const result = spawnSync('exiftool', [
      '-overwrite_original', '-q', '-m',
      `-IFD0:ImageDescription=${caption}`,
      `-IFD0:Artist=${artist}`,
      `-XMP-dc:Title=${it.title}`,
      `-XMP-dc:Creator=${artist}`,
      `-XMP-dc:Description=${desc}`,
      `-XMP-dc:Date=${it.date ?? ''}`,
      `-XMP-dc:Format=${medium}`,
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
    m.push(`-Mset Xmp.dc.title ${it.title}`);
    if (artist) m.push(`-Mset Xmp.dc.creator ${artist}`);
    if (desc) m.push(`-Mset Xmp.dc.description ${desc}`);
    if (it.date) m.push(`-Mset Xmp.dc.date ${it.date}`);
    if (medium) m.push(`-Mset Xmp.dc.format ${medium}`);
    if (it.dimensions) m.push(`-Mset Xmp.dc.extent ${it.dimensions}`);
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
export function writeSidecar(path: string, it: ArtItem, res: string): void {
  const sidecarPath = `${path}.txt`;
  writeFileSync(sidecarPath, sidecarText(it, res), 'utf8');
}
