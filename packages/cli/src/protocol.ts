/**
 * Chrome native-messaging wire protocol — ported from harpe/nativehost.py.
 * Each message is a 4-byte little-endian uint32 length prefix followed by UTF-8
 * JSON. Host→browser messages are capped at 1 MiB by Chrome, so replies are
 * trimmed to fit. Request/reply shapes come from @harpe/core (single contract).
 */
import { Buffer } from 'node:buffer';
import type { HostReply, HostRequest } from '@harpe/core';

/** Chrome's hard cap on a single host→browser message. */
export const MAX_HOST_MESSAGE = 1024 * 1024;

/** Frame a value as a native-messaging message (4-byte LE length + JSON). */
export function encodeMessage(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Parse a single framed message from a buffer (throws if incomplete). */
export function decodeMessage(buf: Buffer): HostRequest {
  if (buf.length < 4) throw new Error('short frame: no length prefix');
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) throw new Error('short frame: truncated body');
  return JSON.parse(buf.toString('utf8', 4, 4 + len)) as HostRequest;
}

/**
 * Ensure a reply fits Chrome's 1 MiB cap. If a results-bearing reply is too big,
 * drop entries (newest-last) and flag truncation rather than overflowing the pipe.
 */
export function capReply(reply: HostReply): HostReply {
  if (encodeMessage(reply).length <= MAX_HOST_MESSAGE) return reply;
  if ('results' in reply && Array.isArray(reply.results)) {
    const results = [...reply.results];
    while (results.length && encodeMessage({ results, truncated: true }).length > MAX_HOST_MESSAGE) {
      results.pop();
    }
    return { results, truncated: true } as HostReply;
  }
  return reply; // non-results replies are always small
}

/**
 * Read framed messages off a byte stream (stdin), yielding each parsed request.
 * Handles partial reads by buffering until a full frame is available.
 */
export async function* readFrames(stream: AsyncIterable<Buffer>): AsyncGenerator<HostRequest> {
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      yield JSON.parse(buf.toString('utf8', 4, 4 + len)) as HostRequest;
      buf = buf.subarray(4 + len);
    }
  }
}
