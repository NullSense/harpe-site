/**
 * Search relevance — diacritic-folding, intent-aware, lightly fuzzy.
 *
 * Why this exists: museum APIs vary wildly. Precise ones (Met, AIC) rank well;
 * greedy ones (Nasjonalmuseet, DigitalNZ) OR-match any single common word, so
 * "John Martin pandemonium painting" returns "John Braun", "Martin Tranmæl". And
 * names carry diacritics ("Tranmæl", "Sølvberg") that naive substring matching
 * misses. This module gives one shared, tested scorer used to (a) ORDER results
 * and (b) GATE the greedy sources.
 *
 * Pure + exported so it's unit-tested (search.test.ts) and shared by the client
 * ranker. The server (src/lib/server/handlers/art.ts) imports it directly.
 */

// ─── Normalisation ─────────────────────────────────────────────────────────────

/** Lowercase, strip diacritics, fold Nordic/ligature letters, drop punctuation.
 *  "Tranmæl" → "tranmael", "Sølvberg" → "solvberg", "Müller" → "muller". */
export function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining accents
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/œ/g, 'oe').replace(/ß/g, 'ss').replace(/ð/g, 'd').replace(/þ/g, 'th')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'the', 'and', 'of', 'to', 'in', 'on', 'by', 'with', 'from', 'for',
  'his', 'her', 'its', 'a', 'an', 'at', 'as',
]);

/** Significant query tokens (normalised, ≥3 chars, no stopwords). */
export function tokenize(q: string): string[] {
  return normalize(q).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
}

// ─── Intent detection ──────────────────────────────────────────────────────────

// Words that signal a subject/medium query rather than a person's name.
const SUBJECT_HINT =
  /\b(painting|paintings|portrait|landscape|seascape|drawing|sketch|sculpture|statue|print|prints|etching|engraving|photo|photograph|poster|still|life|view|scene|study|untitled|nude|figure|vase|bowl|cup|chair|map)\b/i;

/**
 * Does the query look like a person's name? Then we weight the ARTIST field, so
 * "Edvard Munch" ranks Munch's works above a painting merely titled "…Edvard…".
 * Heuristic: 1–3 words, no subject/medium keyword, mostly capitalised (proper
 * nouns) — a lowercase particle like "van"/"de" is allowed.
 */
export function looksLikeName(raw: string): boolean {
  const words = (raw || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  if (SUBJECT_HINT.test(raw)) return false;
  const caps = words.filter((w) => /^[A-ZÀ-Þ]/.test(w)).length;
  return caps >= Math.max(1, words.length - 1);
}

/** First-letter initials of a name: "John William Waterhouse" → "jww". */
function initialsOf(s: string): string {
  return normalize(s).split(' ').filter(Boolean).map((w) => w[0]).join('');
}

/** Short, initials-looking query tokens ("jw", "jmw") — vowel-free or 2-char. */
function initialTokens(query: string): string[] {
  return normalize(query)
    .split(' ')
    .filter((t) => t.length >= 2 && t.length <= 3 && (t.length === 2 || !/[aeiou]/.test(t)));
}

// ─── Fuzzy token matching ──────────────────────────────────────────────────────

/** True if a and b are within edit distance 1 (one insert/delete/substitute). */
export function within1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

/**
 * Jaro-Winkler similarity (0..1) — prefix-weighted, the standard metric for
 * matching personal names ("Sohlberg" vs "Solberg", "Müller" vs "Mueller").
 * Catches more real typos than plain edit distance and rewards shared prefixes,
 * which suits surnames. Cheap: O(a·b) on short tokens, no DP matrix.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aM = new Array(la).fill(false);
  const bM = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(i + range + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = bM[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  const jaro = (matches / la + matches / lb + (matches - t) / matches) / 3;
  let prefix = 0;
  const maxP = Math.min(4, la, lb);
  for (let i = 0; i < maxP; i++) { if (a[i] === b[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Does token `t` appear in `hay` — exact substring, or (for longer tokens) a
 *  Jaro-Winkler near-match against any word in `hay` (typo / spelling variants)? */
function tokenHit(hay: string, hayWords: string[], t: string): boolean {
  if (hay.includes(t)) return true;
  if (t.length >= 4) for (const w of hayWords) if (w.length >= 4 && jaroWinkler(w, t) >= 0.88) return true;
  return false;
}

// ─── Scoring + gating ──────────────────────────────────────────────────────────

export interface Scorable {
  title?: string;
  artist?: string;
}

/**
 * Relevance score (0 = no match, higher = better) used to ORDER results. Rewards
 * exact-phrase and all-token matches, weights the artist field for name queries,
 * and tolerates diacritics + small typos.
 */
export function relevanceScore(item: Scorable, query: string, idf?: (t: string) => number): number {
  const toks = tokenize(query);
  if (toks.length === 0) return 1; // neutral keep
  const nameQuery = looksLikeName(query);
  const nq = normalize(query);
  const title = normalize(item.title || '');
  const artist = normalize(item.artist || '');
  const titleWords = title.split(' ');
  const artistWords = artist.split(' ');
  // Per-token weight: when an IDF function is supplied (computed over the result
  // pool), rare/discriminating tokens ("pandemonium") outweigh common ones
  // ("john", "saint") — so a hit on the meaningful word ranks above name noise.
  const w = (t: string) => (idf ? Math.max(0.5, idf(t)) : 1);

  let score = 0;
  if (nq && title.includes(nq)) score += 6;       // exact phrase in title
  if (nq && artist.includes(nq)) score += nameQuery ? 9 : 5; // exact name match

  let titleHits = 0, artistHits = 0;
  for (const t of toks) {
    const ww = w(t);
    if (tokenHit(title, titleWords, t)) { score += ww; titleHits++; }
    if (tokenHit(artist, artistWords, t)) { score += ww * (nameQuery ? 2 : 1); artistHits++; }
  }
  if (titleHits === toks.length) score += 3;                    // all tokens in title
  if (artistHits === toks.length) score += nameQuery ? 5 : 3;   // all tokens in artist

  // Initialism match: "JW" → John William Waterhouse, not Yoshiki Waterhouse.
  // (Initials of the name-words contain the query's initials run, in order.)
  if (nameQuery) {
    const inits = initialsOf(`${item.title || ''} ${item.artist || ''}`);
    for (const t of initialTokens(query)) if (inits.includes(t)) { score += 4; break; }
  }
  return score;
}

/**
 * Relevance GATE for greedy text-search APIs: keep an item only if it genuinely
 * matches the query — the most specific (longest) token, ≥half the tokens, or
 * (for a name query) the artist field. Drops single-common-word noise like
 * "John Braun" for "John Martin painting". With no usable tokens, keeps all.
 */
export function isRelevant(item: Scorable, query: string): boolean {
  const toks = tokenize(query);
  if (toks.length === 0) return true;
  const title = normalize(item.title || '');
  const artist = normalize(item.artist || '');
  const hay = `${title} ${artist}`.trim();
  const hayWords = hay.split(' ');
  const hits = toks.filter((t) => tokenHit(hay, hayWords, t));
  if (hits.length === 0) return false;
  const longest = toks.reduce((a, b) => (b.length > a.length ? b : a));
  if (tokenHit(hay, hayWords, longest)) return true;
  if (hits.length * 2 >= toks.length) return true;
  // A name query whose artist field matches is relevant even on one token
  // (e.g. surname-only hit), but a lone first-name hit in the TITLE is not.
  if (looksLikeName(query)) {
    const artistWords = artist.split(' ');
    if (toks.some((t) => tokenHit(artist, artistWords, t))) return true;
  }
  return false;
}

// ─── Result fusion (metasearch ranking) ────────────────────────────────────────

/** Group key for "the same work across sources" (diacritic-folded title+artist). */
export function workKey(it: { title?: string; artist?: string }): string {
  const t = normalize(it.title || '').replace(/\b(the|a|an)\b/g, '').replace(/\s+/g, ' ').trim();
  const a = normalize(it.artist || '');
  return `${t}|${a}`;
}

export interface Fusable {
  id: string;
  source: string;
  title?: string;
  artist?: string;
  isPublicDomain?: boolean;
}

export interface FuseOptions<T> {
  /** Quality prior per item (paintings up, repros/books/aggregator-junk down). */
  qualityOf?: (it: T) => number;
  /** Override the "same work" grouping for the cross-source consensus boost. */
  workKeyOf?: (it: T) => string;
}

/**
 * Rank a merged, multi-source result pool with **Reciprocal Rank Fusion** — the
 * standard metasearch technique (Cormack 2009; the default in Elasticsearch /
 * OpenSearch / Azure AI Search). We fuse three independent ranked lists by rank
 * (scale-free, no fragile score normalisation):
 *
 *   1. SOURCE rank   — each item's position within its own API's results, so each
 *                      museum's expert ranking of its own corpus is preserved.
 *   2. RELEVANCE rank — all items by IDF-weighted, name-aware, fuzzy query match,
 *                      so the actual work searched for floats up regardless of
 *                      which source it came from ("Rodin Thinker" → The Thinker).
 *   3. QUALITY rank   — the medium/source prior (optional).
 *
 * Plus a CONSENSUS boost: a work returned by several museums is more likely the
 * real target, so it rises (the classic RRF multi-list reward). Pure JS, O(N·log N)
 * on the ~150-item pool — microseconds, zero dependencies.
 */
export function fuse<T extends Fusable>(items: T[], query: string, opts: FuseOptions<T> = {}): T[] {
  if (items.length <= 1) return [...items];
  const K = 60; // RRF smoothing constant (Cormack 2009)
  const keyOf = opts.workKeyOf ?? workKey;

  // 1) source rank — running position within each source (arrival order = the
  //    API's own relevance order, since items stream grouped by source).
  const srcRank = new Map<T, number>();
  const srcSeen: Record<string, number> = {};
  for (const it of items) {
    const r = (srcSeen[it.source] ?? -1) + 1;
    srcSeen[it.source] = r;
    srcRank.set(it, r);
  }

  // 2) local IDF over the pool — rare query tokens are more discriminating.
  const df = new Map<string, number>();
  for (const it of items) {
    for (const t of new Set(tokenize(`${it.title || ''} ${it.artist || ''}`))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = items.length;
  const idf = (t: string) => Math.log(1 + N / ((df.get(t) ?? 0) + 0.5));

  // Precompute the relevance + quality signals, then turn each into a rank list.
  const rel = new Map<T, number>();
  for (const it of items) rel.set(it, relevanceScore(it, query, idf));
  const qual = opts.qualityOf ? new Map(items.map((it) => [it, opts.qualityOf!(it)] as const)) : null;

  const rankOf = (scoreOf: (it: T) => number): Map<T, number> => {
    const sorted = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
    const m = new Map<T, number>();
    sorted.forEach((it, i) => m.set(it, i));
    return m;
  };
  const relRank = rankOf((it) => rel.get(it)!);
  const qualRank = qual ? rankOf((it) => qual.get(it)!) : null;

  // consensus: how many distinct sources returned the same work.
  const sourcesPerWork = new Map<string, Set<string>>();
  for (const it of items) {
    const k = keyOf(it);
    (sourcesPerWork.get(k) ?? sourcesPerWork.set(k, new Set()).get(k)!).add(it.source);
  }

  // Weighted RRF: relevance leads, the source's own ranking supports it, quality
  // nudges, consensus rewards cross-museum agreement.
  const W_REL = 3, W_SRC = 1, W_QUAL = 0.6, W_CONSENSUS = 0.4;
  const fused = new Map<T, number>();
  for (const it of items) {
    let s = W_REL / (K + relRank.get(it)!) + W_SRC / (K + srcRank.get(it)!);
    if (qualRank) s += W_QUAL / (K + qualRank.get(it)!);
    const consensus = (sourcesPerWork.get(keyOf(it))?.size ?? 1) - 1;
    if (consensus > 0) s += W_CONSENSUS * (Math.min(consensus, 3) / 3) / (K + srcRank.get(it)!) * K;
    fused.set(it, s);
  }

  return [...items].sort((a, b) => {
    const d = (fused.get(b)! - fused.get(a)!);
    if (Math.abs(d) > 1e-12) return d > 0 ? 1 : -1;
    if (!!a.isPublicDomain !== !!b.isPublicDomain) return a.isPublicDomain ? -1 : 1;
    return srcRank.get(a)! - srcRank.get(b)!;
  });
}

/**
 * The full search pipeline, shared by the client ranker and the /api/art handler:
 *
 *   1. DE-DUP by id        — unique React keys + correct by-id detail lookup.
 *   2. RELEVANCE GATE      — drop items that don't match the query at all. Museum
 *                            APIs return *fallback* hits when a query doesn't match
 *                            (AIC dumps "Nighthawks", MoMA a subway map for "JW
 *                            Waterhouse"); ranking alone can't remove them, a gate
 *                            can. Falls back to the ungated set if the gate would
 *                            empty the results (foreign-language / subject matches).
 *   3. RRF FUSE            — rank the survivors (see `fuse`).
 */
export function rankResults<T extends Fusable>(items: T[], query: string, opts: FuseOptions<T> = {}): T[] {
  const seen = new Set<string>();
  const unique = items.filter((it) => (it.id && !seen.has(it.id) ? (seen.add(it.id), true) : false));
  const gated = unique.filter((it) => isRelevant(it, query));
  return fuse(gated.length > 0 ? gated : unique, query, opts);
}
