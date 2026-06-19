/**
 * Result-quality heuristics (free, no model). Derived from sampling ~1200 live
 * results: real paintings up; reproductions / photos-of-art / book-catalog records
 * / aggregator junk down. Query-aware — it never penalises a medium the user
 * explicitly searched for (e.g. searching "engraving" must not bury engravings).
 *
 * Pure + exported so it's unit-tested (ranking.test.ts) and shared by the client
 * ranker. The server (src/lib/server/handlers/art.ts) imports it directly.
 */

export interface RankableItem {
  medium?: string;
  title?: string;
  source: string;
  /** Pixel dimensions — a resolution/quality signal (museum scan vs thumbnail). */
  width?: number;
  height?: number;
  /** Freely-reusable works rank slightly higher on a download-focused site. */
  isPublicDomain?: boolean;
  /** Wikidata sitelink count — a fame/notability prior so iconic works float up
   *  (set at ingest for Wikidata works; undefined elsewhere → no effect). */
  nbSitelinks?: number;
}

const PAINT_RE = /\b(oil|tempera|acrylic|gouache|fresco|distemper|encaustic|watercolou?r|panel|canvas)\b/;
const REPRO_RE = /\b(photograph|photo|negative|gelatin silver|transparency|lantern|daguerreotype|photomechanical|collotype|halftone|photogravure|lithograph|etching|engraving|woodcut|mezzotint|serigraph|screen ?print|poster|postcard|reproduction|xerography)\b/;
// Book / catalog records: pagination ("348 p."), plates, frontispiece, binding…
const BOOK_RE = /\b(book|bound volume|frontispiece|title page|folio|pamphlet|magazine|periodical|leaflet|spine|binding|dust jacket)\b|\b\d{1,4}\s*p\.|leaves of plate|\bp\.\s*illus|\billus\./;
const WANT_BOOK_RE = /\b(book|magazine|periodical|pamphlet|manuscript|illustration)\b/;
// Amateur "photo OF an artwork" — angle / frame / condition / crop cues in the
// title, the junk that litters Wikimedia Commons ("…-tilted", "avec cadre" = with
// frame, "(Louvre)-cropped", "detail", "verso", "before restoration", "raking
// light"). These bury the clean flat reproduction of the same painting; demote
// them hard unless the user is actually after photographs.
// "on the wall" must be verb-anchored (hung/mounted/…) so it catches gallery-photo
// captions without burying canonical titles like "Writing on the Wall" (Belshazzar).
// "signature of …" was dropped — the small-area penalty already sinks signature
// crops, and the phrase wrongly hit titles like "Signature of Charles I".
const PHOTO_OF_ART_RE = /\b(tilted|cropped|detail|verso|recto|framed|reframed|unframed|before restoration|after (cleaning|restoration)|raking light|infra-?red|x-?ray|backside|reverse side|in its frame|with frame|in frame|angled|perspective view|wide shot|close-?up|on display|gallery view)\b|\b(hung|mounted|displayed|installed|exhibited)\s+on the wall\b|avec\s+cadre|sans\s+cadre/i;
// digitalnz/commons are noisy; wikidata/europeana are aggregators with variable
// metadata — a soft penalty aligns ranking with their representative-pick priority.
const SRC_PRIOR: Record<string, number> = { digitalnz: -5, commons: -1, si: -1, wikidata: -0.5, europeana: -0.5 };

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

// ─── Faceted-filter helpers (medium / date) ────────────────────────────────────

export type MediumCat = 'painting' | 'print' | 'photo' | 'drawing' | 'sculpture' | 'textile' | 'other';

export function mediumCategory(medium = ''): MediumCat {
  const m = medium.toLowerCase();
  if (/\b(oil|tempera|acrylic|gouache|fresco|watercolou?r|painting|canvas|panel)\b/.test(m)) return 'painting';
  if (/\b(photograph|photo|gelatin silver|albumen|daguerreotype|negative|transparency|collotype)\b/.test(m)) return 'photo';
  if (/\b(lithograph|etching|engraving|woodcut|mezzotint|screen ?print|serigraph|aquatint|woodblock|\bprint\b|poster)\b/.test(m)) return 'print';
  if (/\b(drawing|chalk|charcoal|graphite|pencil|pen and ink|\bink\b|pastel|sketch|crayon)\b/.test(m)) return 'drawing';
  if (/\b(sculpt|bronze|marble|plaster|terracotta|statue|relief|carv|cast)\b/.test(m)) return 'sculpture';
  if (/\b(textile|tapestry|embroidery|silk|cotton|\bwool\b|woven|weav|garment|costume|lace)\b/.test(m)) return 'textile';
  return 'other';
}

/** First 3–4 digit year in a free-text date ("ca. 1665" → 1665, "-630" → -630). */
export function yearOf(date = ''): number | null {
  const m = /(-?\d{3,4})/.exec(date);
  return m ? parseInt(m[1], 10) : null;
}

export function qualityScore(item: RankableItem, query = ''): number {
  let s = 0;
  const med = (item.medium || '').toLowerCase();
  const t = (item.title || '').toLowerCase();
  const q = query.toLowerCase();
  const wantsRepro = REPRO_RE.test(q);          // user searched a print/photo medium
  const wantsBook = WANT_BOOK_RE.test(q);
  const wantsPhotoOfArt = PHOTO_OF_ART_RE.test(q);
  if (PAINT_RE.test(med) && !wantsRepro) s += 4;
  if (REPRO_RE.test(med) && !wantsRepro) s -= 3;
  if ((BOOK_RE.test(med) || BOOK_RE.test(t)) && !wantsBook) s -= 4;
  if (/\bafter [a-z]|reproduction|postcard|photograph of\b/.test(t)) s -= 2;
  // Amateur photo-of-artwork (tilted / framed / detail / …): demote so the clean
  // reproduction of the same work outranks someone's snapshot of it in a gallery.
  if (PHOTO_OF_ART_RE.test(t) && !wantsPhotoOfArt) s -= 5;
  // Internet-Archive / Commons book-scan uploads: title ends in a long numeric
  // media id, e.g. "The gods of the Egyptians (1904) (14763839232)". Dozens of
  // near-identical plates from one book; demote hard so real works rank above them.
  if (!wantsBook && /\(\d{7,}\)\s*$/.test(t)) s -= 6;
  // Resolution + notability are POSITIVE signals, but only some sources expose
  // pixel dims / sitelinks (dump, AIC, Commons, Harvard, WikiArt) while others
  // (Met, V&A, Wikidata-live) don't — so an uncapped stack would systematically
  // demote the dimensionless museums. Cap the combined positive bonus so quality
  // nudges ranking without letting an enriched item leapfrog a relevant one.
  const area = (item.width ?? 0) * (item.height ?? 0);
  let bonus = 0;
  if (area >= 4_000_000) bonus += 2;        // ≥2 MP — full museum scan
  else if (area >= 1_000_000) bonus += 1;   // ~1 MP — decent scan
  // log-scaled fame prior (sitelinks): iconic works float above minor ones.
  if (item.nbSitelinks && item.nbSitelinks > 0) bonus += Math.min(2, Math.log2(item.nbSitelinks + 1) * 0.6);
  s += Math.min(3, bonus);                  // cap the stacked enrichment advantage
  // Small-image PENALTIES are uncapped (thumbnails/signature crops should sink),
  // and only apply when dims are known (area>0) so live items aren't punished.
  if (area > 0 && area < 50_000) s -= 4;    // <~224² — thumbnail / signature / icon
  else if (area > 0 && area < 200_000) s -= 2; // <~447² — low-res
  // Public-domain works rank slightly higher on a download-focused site.
  if (item.isPublicDomain) s += 1;
  s += SRC_PRIOR[item.source] ?? 0;
  return s;
}
