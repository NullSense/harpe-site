import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { handle, run, type HostDeps } from './nativehost';
import { encodeMessage, decodeMessage } from './protocol';
import type { MediaKind } from '@harpe/core';

// Ported from harpe tests/test_nativehost.py (handler dispatch + run loop).
const DIRS: Record<MediaKind, string> = { image: '/img', video: '/vid', audio: '/aud' };

function deps(over: Partial<HostDeps> = {}): HostDeps {
  return {
    fetchImages: vi.fn(async () => []) as unknown as HostDeps['fetchImages'],
    openInFileManager: vi.fn(async () => {}),
    pickFolder: vi.fn(async () => '/chosen/dir'),
    defaultDirs: () => DIRS,
    version: '1.2.3',
    ...over,
  };
}

describe('handle', () => {
  it('ping → ok/pong/defaults/version', async () => {
    const r = await handle({ ping: true }, deps());
    expect(r).toEqual({ ok: true, pong: true, defaults: DIRS, version: '1.2.3' });
  });

  it('open → dispatches to the file manager', async () => {
    const open = vi.fn(async () => {});
    expect(await handle({ open: '/x/y' }, deps({ openInFileManager: open }))).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith('/x/y');
  });

  it('open failure → {ok:false, error}', async () => {
    const open = vi.fn(async () => { throw new Error('no file manager'); });
    const r = await handle({ open: '/x' }, deps({ openInFileManager: open }));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('no file manager');
  });

  it('pick → returns the chosen path', async () => {
    expect(await handle({ pick: true, start: '~' }, deps())).toEqual({ ok: true, path: '/chosen/dir' });
  });

  it('grab → passes urls/referer/items/group/roots to the engine', async () => {
    let captured: unknown;
    const fetchImages = vi.fn(async (_urls: string[], opts: unknown) => { captured = opts; return [{ url: 'u', ok: true }]; });
    const url = 'https://video.twimg.com/x/clip.mp4';
    const r = await handle({
      urls: [url], referer: 'https://x.com/bob/status/1',
      dirs: { video: '~/V' }, group: 'author', items: { [url]: { name: 'a nice tweet', author: 'bob' } },
    }, deps({ fetchImages: fetchImages as unknown as HostDeps['fetchImages'] }));
    expect(r).toEqual({ results: [{ url: 'u', ok: true }] });
    expect(captured).toMatchObject({ group: 'author', roots: { video: '~/V' }, items: { [url]: { author: 'bob' } } });
  });

  it('grab with no urls → error', async () => {
    expect(await handle({ urls: [] }, deps())).toEqual({ results: [], error: 'no urls provided' });
  });

  it('invalid group falls back to "site"', async () => {
    let captured: { group?: string } = {};
    const fetchImages = vi.fn(async (_u: string[], opts: { group?: string }) => { captured = opts; return []; });
    await handle({ urls: ['https://h/x.jpg'], group: 'garbage' as never }, deps({ fetchImages: fetchImages as unknown as HostDeps['fetchImages'] }));
    expect(captured.group).toBe('site');
  });
});

describe('run loop', () => {
  it('reads a framed ping and writes a framed reply, then exits on EOF', async () => {
    async function* stdin() { yield encodeMessage({ ping: true }); }
    const chunks: Buffer[] = [];
    const rc = await run(stdin(), { write: (b: Buffer) => chunks.push(b) }, deps());
    expect(rc).toBe(0);
    const reply = decodeMessage(Buffer.concat(chunks)) as unknown as { ok: boolean; pong: boolean };
    expect(reply.ok && reply.pong).toBe(true);
  });
});
