/**
 * /api/deepzoom?url=<page-or-descriptor-url>
 *
 * Detects a zoomable-image descriptor (IIIF info.json, DeepZoom .dzi, or Zoomify
 * ImageProperties.xml) and returns a normalized DeepZoomDescriptor the browser can
 * feed straight to OpenSeadragon (viewing) and to our canvas stitcher (download).
 *
 *   • Direct descriptor URL → fetched + parsed directly.
 *   • Any other page URL    → HTML fetched, descriptor URLs detected, first parsed.
 *
 * Google Arts & Culture uses proprietary signed tiles that no in-browser MIT code
 * can reliably stitch (the scheme rotates), so we detect it and say so honestly —
 * that single case still belongs to the Harpe CLI (dezoomify-rs).
 *
 * SSRF-guarded, rate-limited, cached.
 */

import type { VercelRequest, VercelResponse } from './_vercel.js';
import { fetch } from 'undici';
import { GuardError, guardUrl, pinnedAgent, rateLimit, clientIp } from './_guard.js';
import { descriptorKind, parseDescriptor, findDescriptorUrls, isGoogleArtsAndCulture } from './_deepzoom.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_HTML = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;

async function fetchHtml(url: string, timeoutMs = 9000): Promise<{ finalUrl: string; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { url: safe, ip, family } = await guardUrl(current);
      const res = await fetch(safe, {
        dispatcher: pinnedAgent(ip, family),
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc || hop === MAX_REDIRECTS) throw new GuardError(502, 'Too many redirects');
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) { await res.body?.cancel(); throw new GuardError(502, `Upstream returned ${res.status}`); }
      const reader = res.body?.getReader();
      if (!reader) throw new GuardError(502, 'Empty response body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_HTML) { await reader.cancel(); throw new GuardError(413, 'Page body too large'); }
        chunks.push(value);
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return { finalUrl: res.url || current, html: new TextDecoder('utf-8', { fatal: false }).decode(buf) };
    }
    throw new GuardError(502, 'Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!raw) { res.setHeader('Cache-Control', 'no-store'); return res.status(400).json({ error: 'Missing ?url=' }); }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try {
    await rateLimit(ip);
    await guardUrl(raw);
  } catch (e) {
    if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); return res.status(e.status).json({ error: e.message }); }
    throw e;
  }

  if (isGoogleArtsAndCulture(raw)) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.status(200).json({
      ok: false,
      gaac: true,
      message:
        'Google Arts & Culture uses proprietary signed tiles that rotate — use the Harpe CLI (dezoomify-rs) for these.',
    });
  }

  try {
    // Direct descriptor URL → parse it straight away.
    const kind = descriptorKind(raw);
    if (kind) {
      const d = await parseDescriptor(raw, kind);
      if (!d) { res.setHeader('Cache-Control', 'no-store'); return res.status(422).json({ ok: false, error: 'Could not parse that descriptor' }); }
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({ ok: true, descriptor: d });
    }

    // Otherwise treat it as a page: fetch + detect.
    const { finalUrl, html } = await fetchHtml(raw);
    const candidates = findDescriptorUrls(html, finalUrl).slice(0, 6);
    for (const { url, protocol } of candidates) {
      try {
        const d = await parseDescriptor(url, protocol);
        if (d) {
          d.referer = finalUrl;
          res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
          return res.status(200).json({ ok: true, descriptor: d });
        }
      } catch { /* next */ }
    }
    res.setHeader('Cache-Control', 'public, s-maxage=600');
    return res.status(200).json({ ok: false, message: 'No zoomable-image descriptor found on that page.' });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof GuardError) return res.status(e.status).json({ error: e.message });
    if (e instanceof Error && e.name === 'AbortError') return res.status(504).json({ error: 'Detection timed out' });
    return res.status(502).json({ error: 'Detection failed' });
  }
}
