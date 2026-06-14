/**
 * Result-quality heuristics (free, no model). Derived from sampling ~1200 live
 * results: real paintings up; reproductions / photos-of-art / book-catalog records
 * / aggregator junk down. Query-aware — it never penalises a medium the user
 * explicitly searched for (e.g. searching "engraving" must not bury engravings).
 *
 * Pure + exported so it's unit-tested (ranking.test.ts) and shared by the client
 * ranker. The server (api/art.ts) keeps an identical copy (different build).
 */

export interface RankableItem {
  medium?: string;
  title?: string;
  source: string;
}

const PAINT_RE = /\b(oil|tempera|acrylic|gouache|fresco|distemper|encaustic|watercolou?r|panel|canvas)\b/;
const REPRO_RE = /\b(photograph|photo|negative|gelatin silver|transparency|lantern|daguerreotype|photomechanical|collotype|halftone|photogravure|lithograph|etching|engraving|woodcut|mezzotint|serigraph|screen ?print|poster|postcard|reproduction|xerography)\b/;
// Book / catalog records: pagination ("348 p."), plates, frontispiece, binding…
const BOOK_RE = /\b(book|bound volume|frontispiece|title page|folio|pamphlet|magazine|periodical|leaflet|spine|binding|dust jacket)\b|\b\d{1,4}\s*p\.|leaves of plate|\bp\.\s*illus|\billus\./;
const WANT_BOOK_RE = /\b(book|magazine|periodical|pamphlet|manuscript|illustration)\b/;
const SRC_PRIOR: Record<string, number> = { digitalnz: -5, commons: -1, si: -1 };

/** Strip HTML tags + decode the common entities so raw "<em>…" never shows. */
export function stripHtml(s: string): string {
  if (!s) return s;
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function qualityScore(item: RankableItem, query = ''): number {
  let s = 0;
  const med = (item.medium || '').toLowerCase();
  const t = (item.title || '').toLowerCase();
  const q = query.toLowerCase();
  const wantsRepro = REPRO_RE.test(q);          // user searched a print/photo medium
  const wantsBook = WANT_BOOK_RE.test(q);
  if (PAINT_RE.test(med) && !wantsRepro) s += 4;
  if (REPRO_RE.test(med) && !wantsRepro) s -= 3;
  if ((BOOK_RE.test(med) || BOOK_RE.test(t)) && !wantsBook) s -= 4;
  if (/\bafter [a-z]|reproduction|postcard|photograph of\b/.test(t)) s -= 2;
  s += SRC_PRIOR[item.source] ?? 0;
  return s;
}
