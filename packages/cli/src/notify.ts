/**
 * Desktop notification + clipboard — cross-platform.
 * Ported from harpe/notify.py.
 *
 * On Linux it delegates to ~/bin/grab-notify when present (thumbnail icon +
 * image-to-clipboard). Otherwise: macOS via osascript, bare Linux via
 * notify-send / wl-copy. All best-effort — silently no-ops if tools are missing.
 *
 * Pure helpers (osaEscape, applescriptNotify, applescriptSetclip, notifyCommand)
 * are exported for unit-testing without spawning subprocesses.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GRAB_NOTIFY = join(homedir(), 'bin', 'grab-notify');

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Escape a string for embedding inside an AppleScript double-quoted string. */
export function osaEscape(s: string | null | undefined): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** Build the AppleScript `display notification` command string. */
export function applescriptNotify(caption: string, body: string): string {
  return `display notification "${osaEscape(body)}" with title "${osaEscape(caption)}"`;
}

/** Build the AppleScript clipboard-set command string (PNG class). */
export function applescriptSetclip(path: string): string {
  return `set the clipboard to (read (POSIX file "${osaEscape(path)}") as «class PNGf»)`;
}

export type NotifyPlatform = 'grab-notify' | 'darwin' | 'linux';

/**
 * Decide which notification path to use.
 * Pure: accepts the grab-notify path and platform string as parameters so
 * tests can inject them without touching the filesystem.
 */
export function notifyPlatform(
  grabNotifyPath: string = GRAB_NOTIFY,
  osPlatform: string = process.platform,
): NotifyPlatform {
  if (existsSync(grabNotifyPath)) return 'grab-notify';
  if (osPlatform === 'darwin') return 'darwin';
  return 'linux';
}

// ---------------------------------------------------------------------------
// Subprocess helpers (internal — best-effort, swallow errors)
// ---------------------------------------------------------------------------

function trySpawn(cmd: string, args: string[], input?: Buffer): void {
  try {
    spawnSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {
    // best-effort
  }
}

function which(cmd: string): boolean {
  try {
    const r = spawnSync('which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && Boolean(r.stdout?.trim());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Platform-specific senders (internal)
// ---------------------------------------------------------------------------

function sendMac(path: string, caption: string, body: string): void {
  if (!which('osascript')) return;
  trySpawn('osascript', ['-e', applescriptSetclip(path)]);
  trySpawn('osascript', ['-e', applescriptNotify(caption, body)]);
}

function sendLinux(path: string, caption: string, body: string): void {
  if (which('wl-copy')) {
    if (which('magick')) {
      const png = spawnSync('magick', [path, '-resize', '3000x3000>', 'png:-'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (png.status === 0 && png.stdout) {
        trySpawn('wl-copy', ['--type', 'image/png'], png.stdout as Buffer);
      }
    }
    if (caption || body) {
      trySpawn('wl-copy', ['--primary'], Buffer.from(`${caption}\n\n${body}`));
    }
  }
  if (which('notify-send')) {
    trySpawn('notify-send', ['-a', 'harpe', '-i', path, `🖼 ${caption}`, body]);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a desktop notification for a saved file and copy it to the clipboard.
 * All operations are best-effort; errors are silently swallowed.
 */
export function send(path: string, caption = 'Saved', body = ''): void {
  const platform = notifyPlatform();
  try {
    if (platform === 'grab-notify') {
      trySpawn(GRAB_NOTIFY, [path, caption, body]);
    } else if (platform === 'darwin') {
      sendMac(path, caption, body);
    } else {
      sendLinux(path, caption, body);
    }
  } catch {
    // best-effort
  }
}
