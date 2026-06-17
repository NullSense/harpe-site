/**
 * Native-messaging contract — the single source of truth shared by the engine
 * (the native host) and the browser extension.
 *
 * These identifiers MUST match on both sides: the host manifest registers
 * HOST_NAME and allow-lists the extension origins (EXTENSION_ID / GECKO_ID); the
 * extension calls `chrome.runtime.connectNative(HOST_NAME)`. If they drift, the
 * browser silently can't reach the host — which is exactly why they live here
 * once instead of being copy-pasted across repos.
 */
import type { MediaKind } from './media.js';

/** Native-messaging host name (Chrome manifest "name", Firefox manifest, registry key). */
export const HOST_NAME = 'com.nullsense.harpe';

/** Chromium extension id (derived from the manifest "key"). */
export const EXTENSION_ID = 'ginhcamellmffiamggkiaemdklcnechf';

/** Firefox add-on id (browser_specific_settings.gecko.id). */
export const GECKO_ID = 'harpe@nullsense.com';

// ─── Wire protocol (4-byte LE length prefix + UTF-8 JSON, per message) ──────────

/** A request the extension sends to the host. */
export type HostRequest =
  | { ping: true }
  | { open: string }
  | { pick: true; start?: string }
  | {
      urls: string[];
      referer?: string;
      /** Per-type destination roots: { image, video, audio }. */
      dirs?: Partial<Record<MediaKind, string>>;
      /** Single explicit destination folder (overrides dirs + grouping). */
      dest?: string;
      /** Per-url descriptive naming hints, keyed by url. */
      items?: Record<string, { name?: string; author?: string }>;
      /** Folder grouping under each root. */
      group?: GroupMode;
    };

/** One per-URL download outcome. */
export interface GrabResult {
  url: string;
  ok: boolean;
  path?: string;
  kind?: MediaKind;
  error?: string;
}

/** A reply the host sends back. */
export type HostReply =
  | { ok: true; pong: true; defaults: Record<MediaKind, string>; version: string }
  | { ok: true; path?: string | null }
  | { ok: false; error: string }
  | { results: GrabResult[]; truncated?: boolean; error?: string };

export type GroupMode = 'site' | 'author' | 'both' | 'none';
