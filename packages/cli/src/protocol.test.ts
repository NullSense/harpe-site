import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { encodeMessage, decodeMessage, capReply, readFrames, MAX_HOST_MESSAGE } from './protocol';
import type { HostReply } from '@harpe/core';

// Ported from harpe tests/test_nativehost.py (framing + cap_reply).
describe('native-messaging framing', () => {
  it('round-trips a message (incl. non-ASCII)', () => {
    const msg = { ping: true } as const;
    expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
    const frame = encodeMessage({ open: 'wörld/π' });
    expect(decodeMessage(frame)).toEqual({ open: 'wörld/π' });
  });

  it('writes a correct 4-byte LE length prefix', () => {
    const frame = encodeMessage({ ping: true });
    const body = JSON.stringify({ ping: true });
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(body, 'utf8'));
    expect(frame.length).toBe(4 + Buffer.byteLength(body, 'utf8'));
  });

  it('throws on a truncated frame (no silent garbage)', () => {
    expect(() => decodeMessage(Buffer.from([0x02, 0x00]))).toThrow();
    expect(() => decodeMessage(Buffer.from([0x05, 0x00, 0x00, 0x00, 0x68, 0x69]))).toThrow();
  });

  it('readFrames reassembles messages split across chunks', async () => {
    const full = Buffer.concat([encodeMessage({ ping: true }), encodeMessage({ open: '/x' })]);
    async function* chunks() {
      yield full.subarray(0, 3); // mid-header
      yield full.subarray(3, 10);
      yield full.subarray(10);
    }
    const got = [];
    for await (const m of readFrames(chunks())) got.push(m);
    expect(got).toEqual([{ ping: true }, { open: '/x' }]);
  });
});

describe('capReply', () => {
  it('truncates oversized results and flags it, staying under the cap', () => {
    const big: HostReply = {
      results: Array.from({ length: 2000 }, (_, i) => ({ url: `u${i}`, ok: true, path: 'x'.repeat(2000) })),
    };
    const capped = capReply(big) as { results: unknown[]; truncated?: boolean };
    expect(capped.truncated).toBe(true);
    expect(capped.results.length).toBeLessThan(2000);
    expect(encodeMessage(capped).length).toBeLessThanOrEqual(MAX_HOST_MESSAGE);
  });

  it('passes small replies through unchanged', () => {
    const r: HostReply = { results: [{ url: 'u', ok: true }] };
    expect(capReply(r)).toEqual(r);
  });
});
