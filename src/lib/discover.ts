/**
 * Discovery data + suggestion engine for the search box.
 *
 * Two jobs:
 *   1. Autocomplete — as you type a (non-URL) query, `suggest()` returns the
 *      best-matching artists / movements / themes to pick from.
 *   2. Empty-state discovery — curated FEATURED_* lists give first-time visitors
 *      something to click before they know what to search for.
 *
 * Everything is a *curated static list*: popular artists are inherently editorial,
 * and a static set means zero latency, no API key, and no broken-image risk — a
 * pick just runs the normal federated museum search, so the payoff is real results.
 *
 * Matching reuses the shared search primitives (normalize/jaroWinkler/tokenize) so
 * it folds diacritics ("Durer" → Dürer) and tolerates small typos ("monay" → Monet)
 * exactly like the result ranker — no extra fuzzy-search dependency.
 */
import { normalize, jaroWinkler, tokenize } from '@harpe/core';

export type SuggestKind = 'artist' | 'movement' | 'theme';

export interface Suggestion {
  /** Display text. */
  label: string;
  /** What gets searched when picked (usually === label). */
  query: string;
  /** Short context line: era / nationality / medium, or a movement blurb. */
  hint: string;
  kind: SuggestKind;
}

// ─── Curated data ────────────────────────────────────────────────────────────
// Spread across periods, regions and media on purpose — discovery should not feel
// like "European male painters only". Hints are terse (era · style / region).

const ARTIST_DATA: ReadonlyArray<readonly [name: string, hint: string]> = [
  ['Vincent van Gogh', 'Dutch · Post-Impressionism'],
  ['Claude Monet', 'French · Impressionism'],
  ['Rembrandt van Rijn', 'Dutch Golden Age'],
  ['Johannes Vermeer', 'Dutch Golden Age'],
  ['Leonardo da Vinci', 'Italian Renaissance'],
  ['Michelangelo', 'Italian Renaissance'],
  ['Raphael', 'Italian Renaissance'],
  ['Sandro Botticelli', 'Italian Renaissance'],
  ['Caravaggio', 'Italian Baroque'],
  ['Titian', 'Venetian Renaissance'],
  ['Albrecht Dürer', 'German Renaissance · prints'],
  ['Pieter Bruegel the Elder', 'Flemish Renaissance'],
  ['Hieronymus Bosch', 'Early Netherlandish'],
  ['Peter Paul Rubens', 'Flemish Baroque'],
  ['Diego Velázquez', 'Spanish Baroque'],
  ['Francisco Goya', 'Spanish Romanticism'],
  ['El Greco', 'Spanish Mannerism'],
  ['J. M. W. Turner', 'British Romanticism'],
  ['John Constable', 'British landscape'],
  ['William Blake', 'British Romantic · prints'],
  ['Caspar David Friedrich', 'German Romanticism'],
  ['Jacques-Louis David', 'French Neoclassicism'],
  ['Eugène Delacroix', 'French Romanticism'],
  ['Édouard Manet', 'French · Realism'],
  ['Edgar Degas', 'French · Impressionism'],
  ['Pierre-Auguste Renoir', 'French · Impressionism'],
  ['Camille Pissarro', 'French · Impressionism'],
  ['Berthe Morisot', 'French · Impressionism'],
  ['Mary Cassatt', 'American · Impressionism'],
  ['Paul Cézanne', 'French · Post-Impressionism'],
  ['Paul Gauguin', 'French · Post-Impressionism'],
  ['Georges Seurat', 'French · Pointillism'],
  ['Henri de Toulouse-Lautrec', 'French · Post-Impressionism'],
  ['Henri Matisse', 'French · Fauvism'],
  ['Pablo Picasso', 'Spanish · Cubism'],
  ['Georges Braque', 'French · Cubism'],
  ['Wassily Kandinsky', 'Russian · Abstraction'],
  ['Paul Klee', 'Swiss-German · Modernism'],
  ['Piet Mondrian', 'Dutch · De Stijl'],
  ['Gustav Klimt', 'Austrian · Symbolism'],
  ['Egon Schiele', 'Austrian Expressionism'],
  ['Edvard Munch', 'Norwegian Expressionism'],
  ['Marc Chagall', 'Russian-French Modernism'],
  ['Salvador Dalí', 'Spanish · Surrealism'],
  ['René Magritte', 'Belgian · Surrealism'],
  ['Joan Miró', 'Spanish · Surrealism'],
  ['Frida Kahlo', 'Mexican · Surrealism'],
  ['Diego Rivera', 'Mexican muralism'],
  ['Georgia O’Keeffe', 'American Modernism'],
  ['Edward Hopper', 'American Realism'],
  ['Grant Wood', 'American Regionalism'],
  ['Jackson Pollock', 'American · Abstract Expressionism'],
  ['Mark Rothko', 'American · Color Field'],
  ['Andy Warhol', 'American · Pop Art'],
  ['Roy Lichtenstein', 'American · Pop Art'],
  ['Jean-Michel Basquiat', 'American · Neo-Expressionism'],
  ['Jackson Pollock', 'American · Abstract Expressionism'],
  ['Katsushika Hokusai', 'Japanese · Ukiyo-e'],
  ['Utagawa Hiroshige', 'Japanese · Ukiyo-e'],
  ['Kitagawa Utamaro', 'Japanese · Ukiyo-e'],
  ['Hilma af Klint', 'Swedish · Abstraction'],
  ['Artemisia Gentileschi', 'Italian Baroque'],
  ['Élisabeth Vigée Le Brun', 'French portraiture'],
  ['John Singer Sargent', 'American portraiture'],
  ['James McNeill Whistler', 'American · Tonalism'],
  ['Winslow Homer', 'American Realism'],
  ['Gustave Courbet', 'French Realism'],
  ['Jean-François Millet', 'French · Barbizon'],
  ['Camille Corot', 'French landscape'],
  ['Dante Gabriel Rossetti', 'British · Pre-Raphaelite'],
  ['John Everett Millais', 'British · Pre-Raphaelite'],
  ['John William Waterhouse', 'British · Pre-Raphaelite'],
  ['Alphonse Mucha', 'Czech · Art Nouveau'],
  ['Hokusai', 'Japanese · Ukiyo-e'],
  ['Ivan Aivazovsky', 'Russian marine painting'],
  ['Ilya Repin', 'Russian Realism'],
  ['Anders Zorn', 'Swedish · Impressionism'],
  ['Joaquín Sorolla', 'Spanish · luminism'],
  ['Tamara de Lempicka', 'Polish · Art Deco'],
  ['Amedeo Modigliani', 'Italian Modernism'],
];

const MOVEMENT_DATA: ReadonlyArray<readonly [name: string, hint: string]> = [
  ['Impressionism', 'light & colour, 1870s France'],
  ['Post-Impressionism', 'after Impressionism, c. 1886'],
  ['Renaissance', 'rebirth of classical art'],
  ['Baroque', 'drama & movement, 17th c.'],
  ['Romanticism', 'emotion & the sublime'],
  ['Realism', 'everyday life, unidealised'],
  ['Surrealism', 'dreams & the unconscious'],
  ['Cubism', 'fractured geometric form'],
  ['Expressionism', 'emotion over realism'],
  ['Art Nouveau', 'organic decorative line'],
  ['Art Deco', 'sleek geometric glamour'],
  ['Symbolism', 'myth, dream & emotion'],
  ['Abstract Expressionism', 'gestural American abstraction'],
  ['Pop Art', 'mass culture & advertising'],
  ['Ukiyo-e', 'Japanese woodblock prints'],
  ['Pre-Raphaelite', 'Victorian medieval revival'],
  ['Fauvism', 'wild, pure colour'],
  ['Pointillism', 'painting in dots'],
  ['Dutch Golden Age', '17th-century Netherlands'],
  ['Rococo', 'ornate, playful 18th c.'],
];

const THEME_DATA: ReadonlyArray<readonly [query: string, hint: string]> = [
  ['starry night sky', 'night skies & stars'],
  ['the great wave', 'Hokusai’s famous wave'],
  ['shipwreck at sea', 'storms & wrecks'],
  ['still life with flowers', 'floral still lifes'],
  ['water lilies', 'Monet’s pond series'],
  ['cats in art', 'cats through history'],
  ['the kiss', 'lovers embracing'],
  ['self portrait', 'artists on themselves'],
  ['winter landscape', 'snow & frozen scenes'],
  ['mythology and gods', 'myth & legend'],
  ['birds and botany', 'natural-history plates'],
  ['old maps', 'antique cartography'],
  ['horses in motion', 'horses & riders'],
  ['the moon', 'lunar imagery'],
  ['dancers and ballet', 'dance in art'],
  ['gardens in bloom', 'gardens & spring'],
];

function build(kind: SuggestKind, rows: ReadonlyArray<readonly [string, string]>): Suggestion[] {
  return rows.map(([label, hint]) => ({ label, query: label, hint, kind }));
}

// De-dup by normalised query (the curated lists intentionally repeat a couple of
// well-known names — e.g. "Hokusai" alongside the full form — so guard the index).
function dedup(list: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = normalize(s.query);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export const ARTISTS: Suggestion[] = dedup(build('artist', ARTIST_DATA));
export const MOVEMENTS: Suggestion[] = dedup(build('movement', MOVEMENT_DATA));
export const THEMES: Suggestion[] = dedup(build('theme', THEME_DATA));

/** The full searchable pool (artists first — most-searched intent). */
export const ALL_SUGGESTIONS: Suggestion[] = [...ARTISTS, ...MOVEMENTS, ...THEMES];

// Curated subsets for the empty-state discovery grid (the most iconic, kept short).
export const FEATURED_ARTISTS: Suggestion[] = [
  'Vincent van Gogh', 'Claude Monet', 'Rembrandt van Rijn', 'Johannes Vermeer',
  'Katsushika Hokusai', 'Gustav Klimt', 'Frida Kahlo', 'Edvard Munch',
  'Leonardo da Vinci', 'Pablo Picasso', 'Georgia O’Keeffe', 'Hilma af Klint',
].map((n) => ARTISTS.find((a) => a.label === n)!).filter(Boolean);

export const FEATURED_MOVEMENTS: Suggestion[] = [
  'Impressionism', 'Ukiyo-e', 'Baroque', 'Surrealism', 'Art Nouveau', 'Pop Art',
].map((n) => MOVEMENTS.find((m) => m.label === n)!).filter(Boolean);

export const FEATURED_THEMES: Suggestion[] = [
  'the great wave', 'water lilies', 'starry night sky', 'still life with flowers',
  'old maps', 'cats in art',
].map((n) => THEMES.find((t) => t.query === n)!).filter(Boolean);

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Score one suggestion against a normalised query. Tiers (high → low):
 *   100 exact · 80 label prefix · 60 any-word prefix · 40 substring ·
 *   20..30 fuzzy token (typo tolerance). 0 = no match.
 * A small kind bias (artist > movement > theme) breaks ties toward the most
 * common intent. Shorter labels win ties so "Monet" beats "Monet, school of".
 */
function scoreSuggestion(s: Suggestion, nq: string, qTokens: string[]): number {
  if (!nq) return 0;
  const label = normalize(s.label);
  if (label === nq) return 100;

  let base = 0;
  if (label.startsWith(nq)) base = 80;
  else {
    const words = label.split(' ');
    if (words.some((w) => w.startsWith(nq))) base = 60;
    else if (label.includes(nq)) base = 40;
    else {
      // Fuzzy: every query token must near-match some label word (handles typos
      // and partial multi-word queries like "van gogh self").
      const labelWords = words.filter(Boolean);
      const all = qTokens.length > 0 && qTokens.every(
        (t) => labelWords.some((w) => w.startsWith(t) || (t.length >= 4 && w.length >= 4 && jaroWinkler(w, t) >= 0.88)),
      );
      if (all) base = qTokens.some((t) => labelWords.some((w) => w.startsWith(t))) ? 30 : 20;
    }
  }
  if (base === 0) return 0;

  const kindBias = s.kind === 'artist' ? 2 : s.kind === 'movement' ? 1 : 0;
  const brevity = Math.max(0, 1.5 - s.label.length / 40); // ≤1.5, shorter = higher
  return base + kindBias + brevity;
}

/**
 * Top suggestions for a typed query, best first. Returns [] for an empty/blank
 * query (the caller shows FEATURED_* discovery instead) and never includes a
 * suggestion identical to the query (no "search X → suggest X" noise).
 */
export function suggest(query: string, limit = 8): Suggestion[] {
  const nq = normalize(query);
  if (!nq) return [];
  const qTokens = tokenize(query);
  const scored: Array<{ s: Suggestion; score: number }> = [];
  for (const s of ALL_SUGGESTIONS) {
    if (normalize(s.query) === nq) continue; // already typed exactly — nothing to add
    const score = scoreSuggestion(s, nq, qTokens);
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.s);
}
