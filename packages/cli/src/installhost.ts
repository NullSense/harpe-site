/**
 * Register Harpe as a native-messaging host for installed browsers.
 *
 * Writes a launcher script (Unix sh / Windows .bat) that executes
 * `harpe --native-host "$@"`, then drops the host manifest into each
 * detected browser's NativeMessagingHosts directory (or the Windows HKCU
 * registry), allowing the Harpe extension to connect.
 *
 * Public API: install() / uninstall() / isInstalled() / autoRegisterOnce().
 * Pure-helper functions (chromeManifest, firefoxManifest, browserManifestPaths)
 * are also exported so tests can exercise them without touching the filesystem.
 *
 * Ported from harpe/installhost.py.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { HOST_NAME, EXTENSION_ID, GECKO_ID } from '@harpe/core';

export { HOST_NAME, EXTENSION_ID, GECKO_ID };

const _DESC = 'Harpe native messaging host — downloads media via the harpe engine.';

// ── OS-specific data / state directories ─────────────────────────────────────

/** Where the launcher script and Windows manifest files live. */
export function dataDir(home?: string): string {
  const h = home ?? homedir();
  if (platform() === 'darwin') return join(h, 'Library', 'Application Support', 'harpe');
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(h, 'AppData', 'Local');
    return join(base, 'harpe');
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(h, '.local', 'share');
  return join(xdg, 'harpe');
}

/** Where the `host-installed` sentinel lives. */
export function stateDir(home?: string): string {
  const h = home ?? homedir();
  if (platform() === 'darwin') return join(h, 'Library', 'Application Support', 'harpe');
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(h, 'AppData', 'Local');
    return join(base, 'harpe');
  }
  const xdg = process.env.XDG_STATE_HOME ?? join(h, '.local', 'state');
  return join(xdg, 'harpe');
}

// ── Manifest payload builders (pure — exported for testing) ──────────────────

/** Chrome-style manifest with allowed_origins. */
export function chromeManifest(launcher: string, ids: string[]): Record<string, unknown> {
  return {
    name: HOST_NAME,
    description: _DESC,
    path: launcher,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

/** Firefox-style manifest with allowed_extensions. */
export function firefoxManifest(launcher: string, ids: string[]): Record<string, unknown> {
  return {
    name: HOST_NAME,
    description: _DESC,
    path: launcher,
    type: 'stdio',
    allowed_extensions: ids,
  };
}

// ── Per-OS browser directory lists ───────────────────────────────────────────

export interface BrowserManifestPaths {
  chromiumDirs: string[];
  firefoxDirs: string[];
  chromiumSubdir: string;
  firefoxSubdir: string;
}

/**
 * Returns the base directories to search for each browser family and the
 * subdirectory name where NativeMessagingHosts manifests live.
 * Exported so tests can override them without touching the filesystem.
 */
export function browserManifestPaths(home?: string, os?: string): BrowserManifestPaths {
  const h = home ?? homedir();
  const plat = os ?? platform();

  if (plat === 'darwin') {
    const a = join(h, 'Library', 'Application Support');
    return {
      chromiumDirs: [
        join(a, 'Google', 'Chrome'),
        join(a, 'Google', 'Chrome Beta'),
        join(a, 'Chromium'),
        join(a, 'BraveSoftware', 'Brave-Browser'),
        join(a, 'Microsoft Edge'),
        join(a, 'Vivaldi'),
        join(a, 'net.imput.helium'),
      ],
      firefoxDirs: [
        join(a, 'Mozilla'),
        join(a, 'LibreWolf'),
        join(a, 'zen'),
      ],
      chromiumSubdir: 'NativeMessagingHosts',
      firefoxSubdir: 'NativeMessagingHosts',
    };
  }

  // Linux (and anything else non-Darwin, non-Win32)
  const c = join(h, '.config');
  return {
    chromiumDirs: [
      join(c, 'google-chrome'),
      join(c, 'google-chrome-beta'),
      join(c, 'chromium'),
      join(c, 'BraveSoftware', 'Brave-Browser'),
      join(c, 'microsoft-edge'),
      join(c, 'vivaldi'),
      join(c, 'helium'),
    ],
    firefoxDirs: [
      join(h, '.mozilla'),
      join(h, '.librewolf'),
      join(h, '.zen'),
    ],
    chromiumSubdir: 'NativeMessagingHosts',
    firefoxSubdir: 'native-messaging-hosts',
  };
}

// ── Windows registry keys ─────────────────────────────────────────────────────

const WIN_CHROME_KEYS = [
  `Software\\Google\\Chrome\\NativeMessagingHosts`,
  `Software\\Microsoft\\Edge\\NativeMessagingHosts`,
  `Software\\Chromium\\NativeMessagingHosts`,
  `Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts`,
];
const WIN_FIREFOX_KEYS = [`Software\\Mozilla\\NativeMessagingHosts`];

function regAdd(keyPath: string, value: string): void {
  // HKCU\<keyPath>\<HOST_NAME> @="<value>"
  const fullKey = `HKCU\\${keyPath}\\${HOST_NAME}`;
  execFileSync('reg.exe', ['add', fullKey, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
}

function regDelete(keyPath: string): void {
  const fullKey = `HKCU\\${keyPath}\\${HOST_NAME}`;
  try {
    execFileSync('reg.exe', ['delete', fullKey, '/f'], { stdio: 'ignore' });
  } catch {
    // key didn't exist — ignore
  }
}

// ── Launcher script ───────────────────────────────────────────────────────────

/**
 * Write the launcher the browser executes, returning its absolute path.
 * On Unix this is a chmod +x shell script; on Windows a .bat file.
 * Accepts an optional `baseDir` override for testability.
 */
export function writeLauncher(baseDir?: string): string {
  const dir = baseDir ?? dataDir();
  mkdirSync(dir, { recursive: true });

  if (platform() === 'win32') {
    const p = join(dir, 'harpe-native-host.bat');
    writeFileSync(p, `@echo off\r\n"harpe" --native-host %*\r\n`, 'utf8');
    return p;
  }

  const p = join(dir, 'harpe-native-host');
  writeFileSync(p, `#!/bin/sh\nexec "harpe" --native-host "$@"\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

// ── Windows install/uninstall ─────────────────────────────────────────────────

function installWindows(
  launcher: string,
  chromeIds: string[],
  firefoxIds: string[],
  baseDir?: string,
): string[] {
  const dir = baseDir ?? dataDir();
  mkdirSync(dir, { recursive: true });

  const chromeMf = join(dir, `${HOST_NAME}.json`);
  const ffMf = join(dir, `${HOST_NAME}.firefox.json`);
  writeFileSync(chromeMf, JSON.stringify(chromeManifest(launcher, chromeIds), null, 2), 'utf8');
  writeFileSync(ffMf, JSON.stringify(firefoxManifest(launcher, firefoxIds), null, 2), 'utf8');

  const written: string[] = [];
  const pairs: [string[], string][] = [
    [WIN_CHROME_KEYS, chromeMf],
    [WIN_FIREFOX_KEYS, ffMf],
  ];
  for (const [keys, mf] of pairs) {
    for (const keyPath of keys) {
      try {
        regAdd(keyPath, mf);
        written.push(keyPath);
      } catch {
        // skip keys we can't create (e.g. browser not installed → parent missing)
      }
    }
  }
  return written;
}

function uninstallWindows(): void {
  for (const keyPath of [...WIN_CHROME_KEYS, ...WIN_FIREFOX_KEYS]) {
    regDelete(keyPath);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Extra Chromium extension IDs to allow beyond the built-in EXTENSION_ID. */
  extraChromeIds?: string[];
  /** Extra Firefox add-on IDs to allow beyond the built-in GECKO_ID. */
  extraFirefoxIds?: string[];
  /** Write manifests even for browser dirs that don't currently exist. */
  allBrowsers?: boolean;
  /**
   * Override the base data dir (used by tests to avoid touching the real FS).
   * On Windows this also controls where the manifest JSON files are written.
   */
  _dataDir?: string;
  /** Override the state dir (used by tests). */
  _stateDir?: string;
  /** Override the browser manifest paths (used by tests). */
  _browserPaths?: BrowserManifestPaths;
}

/**
 * Register the native host for every detected browser.
 * Returns the list of written manifest paths (or registry key paths on Windows).
 * Idempotent.
 */
export async function install(options: InstallOptions = {}): Promise<string[]> {
  const {
    extraChromeIds = [],
    extraFirefoxIds = [],
    allBrowsers = false,
    _dataDir,
    _stateDir,
    _browserPaths,
  } = options;

  const chromeIds = [EXTENSION_ID, ...extraChromeIds];
  const firefoxIds = [GECKO_ID, ...extraFirefoxIds];
  const launcher = writeLauncher(_dataDir);

  let written: string[];

  if (platform() === 'win32') {
    written = installWindows(launcher, chromeIds, firefoxIds, _dataDir);
  } else {
    const paths = _browserPaths ?? browserManifestPaths();
    const { chromiumDirs, firefoxDirs, chromiumSubdir, firefoxSubdir } = paths;
    written = [];

    for (const base of chromiumDirs) {
      if (allBrowsers || existsSync(base)) {
        const dest = join(base, chromiumSubdir);
        mkdirSync(dest, { recursive: true });
        const f = join(dest, `${HOST_NAME}.json`);
        writeFileSync(f, JSON.stringify(chromeManifest(launcher, chromeIds), null, 2), 'utf8');
        written.push(f);
      }
    }

    for (const base of firefoxDirs) {
      if (allBrowsers || existsSync(base)) {
        const dest = join(base, firefoxSubdir);
        mkdirSync(dest, { recursive: true });
        const f = join(dest, `${HOST_NAME}.json`);
        writeFileSync(f, JSON.stringify(firefoxManifest(launcher, firefoxIds), null, 2), 'utf8');
        written.push(f);
      }
    }
  }

  const sd = _stateDir ?? stateDir();
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'host-installed'), launcher + '\n', 'utf8');

  return written;
}

/**
 * Remove the host manifest from every browser. Returns removed paths.
 */
export async function uninstall(options: Pick<InstallOptions, '_stateDir' | '_browserPaths'> = {}): Promise<string[]> {
  const { _stateDir, _browserPaths } = options;
  const removed: string[] = [];

  if (platform() === 'win32') {
    uninstallWindows();
  } else {
    const paths = _browserPaths ?? browserManifestPaths();
    const { chromiumDirs, firefoxDirs, chromiumSubdir, firefoxSubdir } = paths;

    for (const base of chromiumDirs) {
      const f = join(base, chromiumSubdir, `${HOST_NAME}.json`);
      if (existsSync(f)) {
        unlinkSync(f);
        removed.push(f);
      }
    }

    for (const base of firefoxDirs) {
      const f = join(base, firefoxSubdir, `${HOST_NAME}.json`);
      if (existsSync(f)) {
        unlinkSync(f);
        removed.push(f);
      }
    }
  }

  const sentinel = join(_stateDir ?? stateDir(), 'host-installed');
  if (existsSync(sentinel)) {
    unlinkSync(sentinel);
  }

  return removed;
}

/**
 * Returns true if the native host has been registered (sentinel exists).
 */
export function isInstalled(options: Pick<InstallOptions, '_stateDir'> = {}): boolean {
  const { _stateDir } = options;
  return existsSync(join(_stateDir ?? stateDir(), 'host-installed'));
}

/**
 * Best-effort first-run registration: if the host has never been installed,
 * register it and print a one-line notice to STDERR (so it never corrupts
 * `--json` stdout). Guarded by a sentinel so it runs only once; all errors are
 * swallowed so registration trouble can't block normal CLI use.
 */
export async function autoRegisterOnce(options: InstallOptions = {}): Promise<void> {
  if (isInstalled({ _stateDir: options._stateDir })) return;
  try {
    const written = await install(options);
    if (written.length > 0) {
      process.stderr.write(
        `harpe: registered native host for the browser extension (${written.length} location(s)). Run \`harpe uninstall-host\` to undo.\n`,
      );
    }
  } catch {
    // never block normal CLI use on registration trouble
  }
}
