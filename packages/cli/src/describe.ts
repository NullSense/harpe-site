/**
 * Best-effort page description — ported from describe.py without the heavy
 * `trafilatura` dependency. Fetches the page, strips boilerplate tags and
 * collapses whitespace, returning the first `maxChars` of prose. Used to enrich
 * an art candidate's notification body when the source API gave no description.
 * Returns '' on any failure (never throws).
 */
import { parse } from 'node-html-parser';
import { UA } from './config.js';

export async function pageDescription(url: string, maxChars = 600): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return '';
    const root = parse(await res.text());
    root.querySelectorAll('script,style,nav,header,footer,aside,noscript').forEach((n) => n.remove());
    const text =
      root.querySelector('article')?.text ||
      root.querySelector('main')?.text ||
      root.text ||
      '';
    return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  } catch {
    return '';
  }
}
