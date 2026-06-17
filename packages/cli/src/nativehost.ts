/**
 * Harpe as a browser native-messaging host — ported from harpe/nativehost.py.
 * `handle()` dispatches one decoded request to a reply (deps injected so it's
 * unit-testable); `run()` is the stdin→stdout framing loop. Framing + capReply
 * live in ./protocol; the contract types come from @harpe/core.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import type { HostReply, HostRequest, MediaKind } from '@harpe/core';
import { capReply, encodeMessage, readFrames } from './protocol.js';
import { fetchImages } from './engine.js';
import { dirs as DEFAULT_DIRS } from './config.js';

const execFileP = promisify(execFile);
const VERSION = '0';

/** The engine's current per-type roots (so the extension can show real defaults). */
export function defaultDirs(): Record<MediaKind, string> {
  return { image: DEFAULT_DIRS.image, video: DEFAULT_DIRS.video, audio: DEFAULT_DIRS.audio };
}

function expand(p: string): string {
  let s = p;
  if (s.startsWith('~')) s = homedir() + s.slice(1);
  return s.replace(/\$(\w+)|\$\{(\w+)\}/g, (_m, a, b) => process.env[a || b] ?? '');
}

/** Recover desktop session env the browser may not pass (Wayland/DISPLAY/DBUS). */
function linuxSessionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return env;
  const run = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  env.XDG_RUNTIME_DIR ??= run;
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) {
    for (const name of ['wayland-1', 'wayland-0']) {
      if (existsSync(join(run, name))) { env.WAYLAND_DISPLAY = name; break; }
    }
    env.DISPLAY ??= ':0';
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS && existsSync(join(run, 'bus'))) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(run, 'bus')}`;
  }
  return env;
}

/** Reveal a saved file/folder in the OS file manager (throws if none found). */
export async function openInFileManager(target: string): Promise<void> {
  const p = expand(target);
  if (process.platform === 'darwin') { spawn('open', [p], { detached: true }).unref(); return; }
  if (process.platform === 'win32') { spawn('explorer', [p], { detached: true }).unref(); return; }
  const env = linuxSessionEnv();
  for (const cmd of ['xdg-open', 'gio', 'nautilus', 'dolphin', 'thunar', 'nemo', 'pcmanfm']) {
    try {
      const args = cmd === 'gio' ? ['open', p] : [p];
      spawn(cmd, args, { env, detached: true, stdio: 'ignore' }).unref();
      return;
    } catch { /* try the next opener */ }
  }
  throw new Error('no file manager found (xdg-open/gio/nautilus/dolphin/thunar/nemo/pcmanfm)');
}

/** Native folder chooser → chosen absolute path, or null if cancelled/unavailable. */
export async function pickFolder(start?: string): Promise<string | null> {
  const dir = start ? expand(start) : homedir();
  try {
    if (process.platform === 'darwin') {
      const esc = dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `POSIX path of (choose folder with prompt "Harpe — save to" default location POSIX file "${esc}")`;
      const { stdout } = await execFileP('osascript', ['-e', script]);
      return stdout.trim() || null;
    }
    if (process.platform === 'win32') {
      const ps = "Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}";
      const { stdout } = await execFileP('powershell', ['-NoProfile', '-Command', ps]);
      return stdout.trim() || null;
    }
    const env = linuxSessionEnv();
    const { stdout } = await execFileP('zenity', ['--file-selection', '--directory', `--filename=${dir}/`, '--title=Harpe — save to'], { env });
    return stdout.trim() || null;
  } catch {
    return null; // cancelled or chooser unavailable
  }
}

export interface HostDeps {
  fetchImages: typeof fetchImages;
  openInFileManager: (target: string) => Promise<void>;
  pickFolder: (start?: string) => Promise<string | null>;
  defaultDirs: () => Record<MediaKind, string>;
  version: string;
}

const realDeps = (): HostDeps => ({ fetchImages, openInFileManager, pickFolder, defaultDirs, version: VERSION });

const GROUPS = ['site', 'author', 'both', 'none'] as const;

/** Dispatch one decoded request to a reply. I/O is via injected deps (testable). */
export async function handle(msg: HostRequest, deps: HostDeps = realDeps()): Promise<HostReply> {
  if ('ping' in msg && msg.ping) {
    return { ok: true, pong: true, defaults: deps.defaultDirs(), version: deps.version };
  }
  if ('open' in msg && msg.open) {
    try { await deps.openInFileManager(String(msg.open)); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  if ('pick' in msg && msg.pick) {
    try { return { ok: true, path: await deps.pickFolder(msg.start) }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  if ('urls' in msg) {
    const urls = (msg.urls || []).map((u) => String(u).trim()).filter(Boolean);
    if (!urls.length) return { results: [], error: 'no urls provided' };
    const group = GROUPS.includes(msg.group as never) ? (msg.group as (typeof GROUPS)[number]) : 'site';
    const dest = typeof msg.dest === 'string' && msg.dest.trim() ? expand(msg.dest.trim()) : undefined;
    const results = await deps.fetchImages(urls, {
      referer: msg.referer || '', dest, items: msg.items, group, roots: msg.dirs,
    });
    return { results };
  }
  return { ok: false, error: 'unknown request' };
}

/** Native-messaging loop: read framed requests from stdin, reply on stdout. */
export async function run(
  stdin: AsyncIterable<Buffer> = process.stdin,
  stdout: { write: (b: Buffer) => unknown } = process.stdout,
  deps: HostDeps = realDeps(),
): Promise<number> {
  for await (const msg of readFrames(stdin)) {
    if (!msg || Object.keys(msg).length === 0) continue;
    try {
      stdout.write(encodeMessage(capReply(await handle(msg, deps))));
    } catch (e) {
      stdout.write(encodeMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return 0;
}
