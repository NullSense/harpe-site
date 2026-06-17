/**
 * Ported from harpe/tests/test_notify.py.
 * Tests cover only the PURE helper functions — no subprocesses are spawned.
 */
import { describe, it, expect } from 'vitest';
import { osaEscape, applescriptNotify, applescriptSetclip, notifyPlatform } from './notify';

// ---------------------------------------------------------------------------
// osaEscape
// ---------------------------------------------------------------------------
describe('osaEscape', () => {
  it('escapes embedded quotes and backslashes', () => {
    expect(osaEscape('say "hi"\nthere')).toBe('say \\"hi\\" there');
    expect(osaEscape('a\\b')).toBe('a\\\\b');
  });

  it('converts newlines to spaces', () => {
    expect(osaEscape('line1\nline2')).toBe('line1 line2');
  });

  it('returns empty string for null/undefined', () => {
    expect(osaEscape(null)).toBe('');
    expect(osaEscape(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// applescriptNotify
// ---------------------------------------------------------------------------
describe('applescriptNotify', () => {
  it('produces a valid display notification command', () => {
    const s = applescriptNotify('Saved 3 images', 'books.toscrape.com');
    expect(s).toBe('display notification "books.toscrape.com" with title "Saved 3 images"');
  });

  it('escapes special chars in caption and body', () => {
    const s = applescriptNotify('He said "hi"', 'line1\nline2');
    expect(s).toContain('\\"hi\\"');
    expect(s).toContain('line1 line2');
  });
});

// ---------------------------------------------------------------------------
// applescriptSetclip
// ---------------------------------------------------------------------------
describe('applescriptSetclip', () => {
  it('references the correct POSIX file', () => {
    const s = applescriptSetclip('/tmp/a.png');
    expect(s).toContain('(POSIX file "/tmp/a.png")');
    expect(s).toContain('«class PNGf»');
  });

  it('escapes quotes in the path', () => {
    const s = applescriptSetclip('/tmp/my "art".png');
    expect(s).toContain('\\"art\\"');
  });
});

// ---------------------------------------------------------------------------
// notifyPlatform (pure — inject paths/platform string)
// ---------------------------------------------------------------------------
describe('notifyPlatform', () => {
  it('prefers grab-notify when the file exists', () => {
    // Use a path that is guaranteed to exist on every POSIX system.
    expect(notifyPlatform('/dev/null', 'linux')).toBe('grab-notify');
    expect(notifyPlatform('/dev/null', 'darwin')).toBe('grab-notify');
  });

  it('falls back to darwin when grab-notify is absent and platform is darwin', () => {
    expect(notifyPlatform('/non/existent/grab-notify', 'darwin')).toBe('darwin');
  });

  it('falls back to linux for any other platform', () => {
    expect(notifyPlatform('/non/existent/grab-notify', 'linux')).toBe('linux');
    expect(notifyPlatform('/non/existent/grab-notify', 'win32')).toBe('linux');
  });
});
