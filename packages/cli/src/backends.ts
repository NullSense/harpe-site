/**
 * Download backends — ported from harpe/backends.py. Thin wrappers around the
 * same external binaries (yt-dlp / gallery-dl / dezoomify-rs) the Python engine
 * shells out to. Arg builders are pure + tested; the runners spawn.
 */
import { spawn } from 'node:child_process';
import { ytdlpExtraArgs } from './config.js';

const VID_TMPL =
  '%(extractor_key)s/%(uploader_id,uploader|unknown)s/%(title).80B (%(upload_date>%Y-%m-%d|no-date)s) [%(id)s].%(ext)s';

/** yt-dlp args for a max-quality video download into `vidDir`. Pure. */
export function videoArgs(urls: string[], vidDir: string, extra: string[] = ytdlpExtraArgs()): string[] {
  return [
    '-S', 'res,fps,tbr', '--merge-output-format', 'mp4', '--embed-metadata',
    ...extra, '-o', `${vidDir}/${VID_TMPL}`, ...urls,
  ];
}

/** yt-dlp args for a best-quality audio extraction into `audDir`. Pure. */
export function audioArgs(urls: string[], audDir: string, extra: string[] = ytdlpExtraArgs()): string[] {
  return [
    '-x', '--audio-format', 'best', '--audio-quality', '0',
    '--embed-metadata', '--embed-thumbnail',
    ...extra, '-o', `${audDir}/${VID_TMPL}`, ...urls,
  ];
}

/** dezoomify-rs args. maxpx>0 caps the output; 0 = full resolution. Pure. */
export function dezoomifyArgs(src: string, out: string, maxpx = 0): string[] {
  return maxpx > 0
    ? ['--max-width', String(maxpx), '--max-height', String(maxpx), src, out]
    : ['-l', src, out];
}

/** Last path segment (or Google A&C asset id) → a filename slug. Pure. */
export function slugFromUrl(url: string): string {
  const s = url.includes('/asset/')
    ? url.replace(/.*\/asset\/([^/?#]+).*/, '$1')
    : url.replace(/\/+$/, '').replace(/.*\/([^/?#]+).*/, '$1');
  return s || 'artwork';
}

/** Run a command, inheriting stdio; resolve with its exit code (127 if missing). */
function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', () => resolve(127));
    p.on('close', (code) => resolve(code ?? 1));
  });
}

export const video = (urls: string[], vidDir: string) => run('yt-dlp', videoArgs(urls, vidDir));
export const audio = (urls: string[], audDir: string) => run('yt-dlp', audioArgs(urls, audDir));
export const gallery = (urls: string[], dest: string) => run('gallery-dl', ['-d', dest, ...urls]);
export const dezoomify = (src: string, out: string, maxpx = 0) => run('dezoomify-rs', dezoomifyArgs(src, out, maxpx));
