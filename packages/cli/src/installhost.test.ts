/**
 * Tests for installhost.ts — ported from harpe/tests/test_installhost.py.
 *
 * Strategy: the pure helper functions (chromeManifest, firefoxManifest,
 * browserManifestPaths) are tested directly. Filesystem-touching functions
 * (install, uninstall, isInstalled, autoRegisterOnce, writeLauncher) receive
 * a tmpdir override via the _dataDir / _stateDir / _browserPaths options so
 * no real browser dirs or state dirs are touched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  HOST_NAME,
  EXTENSION_ID,
  GECKO_ID,
  chromeManifest,
  firefoxManifest,
  browserManifestPaths,
  writeLauncher,
  install,
  uninstall,
  isInstalled,
  autoRegisterOnce,
  type BrowserManifestPaths,
} from './installhost.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'harpe-test-'));
}

/**
 * Build a BrowserManifestPaths where both chrome and firefox dirs exist on disk
 * (so install() treats them as "detected") with controllable subdir names.
 */
function fakeBrowserPaths(tmp: string): { paths: BrowserManifestPaths; chrome: string; ff: string } {
  const chrome = join(tmp, 'chrome');
  const ff = join(tmp, 'ff');
  mkdirSync(chrome, { recursive: true });
  mkdirSync(ff, { recursive: true });
  const paths: BrowserManifestPaths = {
    chromiumDirs: [chrome],
    firefoxDirs: [ff],
    chromiumSubdir: 'NMH',
    firefoxSubdir: 'nmh',
  };
  return { paths, chrome, ff };
}

// ── pure manifest builders ────────────────────────────────────────────────────

describe('chromeManifest', () => {
  it('has the correct name and type', () => {
    const m = chromeManifest('/launch', [EXTENSION_ID]);
    expect(m['name']).toBe(HOST_NAME);
    expect(m['type']).toBe('stdio');
    expect(m['path']).toBe('/launch');
  });

  it('wraps ids in chrome-extension:// origins', () => {
    const m = chromeManifest('/launch', [EXTENSION_ID, 'other']);
    expect(m['allowed_origins']).toEqual([
      `chrome-extension://${EXTENSION_ID}/`,
      'chrome-extension://other/',
    ]);
  });

  it('does not include allowed_extensions', () => {
    const m = chromeManifest('/launch', [EXTENSION_ID]);
    expect('allowed_extensions' in m).toBe(false);
  });
});

describe('firefoxManifest', () => {
  it('has the correct name and type', () => {
    const m = firefoxManifest('/launch', [GECKO_ID]);
    expect(m['name']).toBe(HOST_NAME);
    expect(m['type']).toBe('stdio');
  });

  it('sets allowed_extensions to the provided ids', () => {
    const m = firefoxManifest('/launch', [GECKO_ID]);
    expect(m['allowed_extensions']).toEqual([GECKO_ID]);
  });

  it('does not include allowed_origins', () => {
    const m = firefoxManifest('/launch', [GECKO_ID]);
    expect('allowed_origins' in m).toBe(false);
  });
});

// ── browserManifestPaths ──────────────────────────────────────────────────────

describe('browserManifestPaths', () => {
  it('linux: chromium subdir is NativeMessagingHosts, firefox is native-messaging-hosts', () => {
    const p = browserManifestPaths('/home/test', 'linux');
    expect(p.chromiumSubdir).toBe('NativeMessagingHosts');
    expect(p.firefoxSubdir).toBe('native-messaging-hosts');
  });

  it('linux: chromium dirs are under ~/.config', () => {
    const p = browserManifestPaths('/home/test', 'linux');
    expect(p.chromiumDirs.some((d) => d.includes('.config'))).toBe(true);
  });

  it('linux: firefox dirs include .mozilla', () => {
    const p = browserManifestPaths('/home/test', 'linux');
    expect(p.firefoxDirs.some((d) => d.endsWith('.mozilla'))).toBe(true);
  });

  it('darwin: both subdirs are NativeMessagingHosts', () => {
    const p = browserManifestPaths('/Users/test', 'darwin');
    expect(p.chromiumSubdir).toBe('NativeMessagingHosts');
    expect(p.firefoxSubdir).toBe('NativeMessagingHosts');
  });

  it('darwin: dirs are under Library/Application Support', () => {
    const p = browserManifestPaths('/Users/test', 'darwin');
    expect(p.chromiumDirs.every((d) => d.includes('Application Support'))).toBe(true);
  });
});

// ── writeLauncher ─────────────────────────────────────────────────────────────

describe('writeLauncher', () => {
  it('writes a script that contains --native-host', () => {
    const tmp = makeTmp();
    const p = writeLauncher(tmp);
    const body = readFileSync(p, 'utf8');
    expect(body).toContain('--native-host');
  });

  it('creates the data dir if it does not exist', () => {
    const tmp = makeTmp();
    const sub = join(tmp, 'deep', 'subdir');
    writeLauncher(sub);
    expect(existsSync(sub)).toBe(true);
  });
});

// ── install / uninstall / isInstalled ────────────────────────────────────────

describe('install + uninstall + isInstalled', () => {
  let tmp: string;
  let chromeDirBase: string;
  let ffDirBase: string;
  let paths: BrowserManifestPaths;

  beforeEach(() => {
    tmp = makeTmp();
    ({ paths, chrome: chromeDirBase, ff: ffDirBase } = fakeBrowserPaths(tmp));
  });

  it('writes manifests to detected browser dirs and creates sentinel', async () => {
    const written = await install({
      _dataDir: join(tmp, 'data'),
      _stateDir: join(tmp, 'state'),
      _browserPaths: paths,
    });

    const cm = join(chromeDirBase, 'NMH', `${HOST_NAME}.json`);
    const fm = join(ffDirBase, 'nmh', `${HOST_NAME}.json`);

    expect(existsSync(cm)).toBe(true);
    expect(existsSync(fm)).toBe(true);
    expect(written).toContain(cm);
    expect(written).toContain(fm);

    const chromeJson = JSON.parse(readFileSync(cm, 'utf8')) as Record<string, unknown>;
    expect((chromeJson['allowed_origins'] as string[])[0]).toMatch(/^chrome-extension:\/\//);

    const ffJson = JSON.parse(readFileSync(fm, 'utf8')) as Record<string, unknown>;
    expect(ffJson['allowed_extensions']).toEqual([GECKO_ID]);

    expect(isInstalled({ _stateDir: join(tmp, 'state') })).toBe(true);
  });

  it('uninstall removes manifests and sentinel, returns removed paths', async () => {
    await install({
      _dataDir: join(tmp, 'data'),
      _stateDir: join(tmp, 'state'),
      _browserPaths: paths,
    });

    const cm = join(chromeDirBase, 'NMH', `${HOST_NAME}.json`);
    const fm = join(ffDirBase, 'nmh', `${HOST_NAME}.json`);

    const removed = await uninstall({
      _stateDir: join(tmp, 'state'),
      _browserPaths: paths,
    });

    expect(existsSync(cm)).toBe(false);
    expect(existsSync(fm)).toBe(false);
    expect(isInstalled({ _stateDir: join(tmp, 'state') })).toBe(false);
    expect(new Set(removed)).toEqual(new Set([cm, fm]));
  });

  it('skips absent browser dirs by default, writes when allBrowsers=true', async () => {
    const absent = join(tmp, 'nonexistent-browser');
    const onlyAbsent: BrowserManifestPaths = {
      chromiumDirs: [absent],
      firefoxDirs: [],
      chromiumSubdir: 'NMH',
      firefoxSubdir: 'nmh',
    };

    const written1 = await install({
      _dataDir: join(tmp, 'data'),
      _stateDir: join(tmp, 'state'),
      _browserPaths: onlyAbsent,
    });
    expect(written1).toHaveLength(0);

    const written2 = await install({
      allBrowsers: true,
      _dataDir: join(tmp, 'data'),
      _stateDir: join(tmp, 'state'),
      _browserPaths: onlyAbsent,
    });
    expect(written2.length).toBeGreaterThan(0);
  });

  it('extra chrome/firefox ids appear in manifests', async () => {
    await install({
      extraChromeIds: ['extra-chrome-id'],
      extraFirefoxIds: ['extra@ff.id'],
      _dataDir: join(tmp, 'data'),
      _stateDir: join(tmp, 'state'),
      _browserPaths: paths,
    });

    const cm = join(chromeDirBase, 'NMH', `${HOST_NAME}.json`);
    const fm = join(ffDirBase, 'nmh', `${HOST_NAME}.json`);
    const chromeJson = JSON.parse(readFileSync(cm, 'utf8')) as Record<string, unknown>;
    const ffJson = JSON.parse(readFileSync(fm, 'utf8')) as Record<string, unknown>;

    expect(chromeJson['allowed_origins']).toContain('chrome-extension://extra-chrome-id/');
    expect(ffJson['allowed_extensions']).toContain('extra@ff.id');
  });
});

// ── autoRegisterOnce ──────────────────────────────────────────────────────────

describe('autoRegisterOnce', () => {
  it('installs on first call and skips on second (idempotent)', async () => {
    const tmp = makeTmp();
    const { paths } = fakeBrowserPaths(tmp);
    const opts = {
      _dataDir: join(tmp, 'data'),
      _stateDir: join(tmp, 'state'),
      _browserPaths: paths,
    };

    expect(isInstalled({ _stateDir: opts._stateDir })).toBe(false);
    await autoRegisterOnce(opts);
    expect(isInstalled({ _stateDir: opts._stateDir })).toBe(true);

    // Second call must not throw and must be a no-op (sentinel already exists)
    await autoRegisterOnce(opts);
    expect(isInstalled({ _stateDir: opts._stateDir })).toBe(true);
  });
});

// ── constant re-exports ───────────────────────────────────────────────────────

describe('exported constants', () => {
  it('HOST_NAME is com.nullsense.harpe', () => {
    expect(HOST_NAME).toBe('com.nullsense.harpe');
  });

  it('EXTENSION_ID is a non-empty string', () => {
    expect(typeof EXTENSION_ID).toBe('string');
    expect(EXTENSION_ID.length).toBeGreaterThan(0);
  });

  it('GECKO_ID ends with @nullsense.com', () => {
    expect(GECKO_ID).toMatch(/@nullsense\.com$/);
  });
});
