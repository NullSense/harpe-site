/**
 * Paths, user agents and env-tunable knobs — ported from harpe/config.py.
 * Everything is read from the environment fresh so a plain install never breaks
 * and the browser extension's per-request overrides take precedence.
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
// macOS calls the video folder "Movies"; Linux/Windows use "Videos".
const VIDEOS = platform() === 'darwin' ? 'Movies' : 'Videos';

/** Default download roots by media type; override with HARPE_*_DIR. */
export const dirs = {
  video: process.env.HARPE_VID_DIR || join(HOME, VIDEOS, 'harpe'),
  image: process.env.HARPE_IMG_DIR || join(HOME, 'Pictures', 'harpe'),
  audio: process.env.HARPE_AUD_DIR || join(HOME, 'Music', 'harpe'),
};
export const ART_DIR = process.env.HARPE_ART_DIR || join(dirs.image, 'art');

// Browser UA — some museum/CDN servers bot-block non-browser agents/hotlinks.
export const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
// Polite descriptive UA for API / SPARQL calls.
export const API_UA = 'harpe/0.1 (personal art archival; +https://commons.wikimedia.org)';

function envInt(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

/** Long-edge cap for saved art (0 = full resolution). */
export const MAXPX = envInt('GRAB_ART_MAXPX', 7680);
/** Page-picker: drop images whose long edge is below this; cap candidates probed. */
export const PAGE_MINPX = envInt('GRAB_PAGE_MINPX', 100);
export const PAGE_MAX = envInt('GRAB_PAGE_MAX', 200);

/**
 * Opt-in yt-dlp hardening, read fresh each call. Always-on resilience for flaky
 * links + large segmented videos; cookies/impersonation are env-gated so a
 * default install never breaks:
 *   HARPE_COOKIES_FROM_BROWSER=firefox  download logged-in content with your session
 *   HARPE_IMPERSONATE=chrome            TLS/HTTP impersonation (needs yt-dlp[curl-cffi])
 */
export function ytdlpExtraArgs(): string[] {
  const args = ['--retries', '3', '--fragment-retries', '10', '--concurrent-fragments', '4'];
  const browser = (process.env.HARPE_COOKIES_FROM_BROWSER ?? '').trim();
  if (browser) args.push('--cookies-from-browser', browser);
  const impersonate = (process.env.HARPE_IMPERSONATE ?? '').trim();
  if (impersonate) args.push('--impersonate', impersonate);
  return args;
}
