import { describe, it, expect } from 'vitest';
import { normalize, tokenize, looksLikeName, within1, jaroWinkler, relevanceScore, isRelevant, workKey, fuse, rankResults } from './search';

describe('normalize', () => {
  it('folds diacritics and Nordic letters', () => {
    expect(normalize('Tranmæl')).toBe('tranmael');
    expect(normalize('Sølvberg')).toBe('solvberg');
    expect(normalize('Müller')).toBe('muller');
    expect(normalize('Edvard Munch')).toBe('edvard munch');
    expect(normalize('Pandæmonium, Rex!')).toBe('pandaemonium rex');
  });
});

describe('tokenize', () => {
  it('drops stopwords and short tokens', () => {
    expect(tokenize('The Birth of Venus')).toEqual(['birth', 'venus']);
    expect(tokenize('a')).toEqual([]);
  });
});

describe('looksLikeName', () => {
  it('detects capitalised 1-3 word names', () => {
    expect(looksLikeName('Edvard Munch')).toBe(true);
    expect(looksLikeName('Harald Sohlberg')).toBe(true);
    expect(looksLikeName('Vincent van Gogh')).toBe(true); // lowercase particle ok
    expect(looksLikeName('Rembrandt')).toBe(true);
  });
  it('rejects subject/medium and long queries', () => {
    expect(looksLikeName('John Martin pandemonium painting')).toBe(false); // has "painting"
    expect(looksLikeName('starry night')).toBe(false);    // lowercase, not a name
    expect(looksLikeName('the birth of venus')).toBe(false);
  });
});

describe('within1 (edit distance ≤ 1)', () => {
  it('accepts one edit, rejects two', () => {
    expect(within1('munch', 'munch')).toBe(true);
    expect(within1('munch', 'munich')).toBe(true);   // 1 insertion
    expect(within1('sohlberg', 'solberg')).toBe(true); // 1 deletion
    expect(within1('monet', 'manet')).toBe(true);    // 1 substitution
    expect(within1('monet', 'money')).toBe(true);
    expect(within1('cat', 'dog')).toBe(false);
  });
});

// Regression: the "Nasjonalmuseet leaking into everything" bug. Greedy search
// OR-matched single common words → "John Braun", "Martin Tranmæl" for the query
// "John Martin pandemonium painting". The gate must drop those, keep real hits.
describe('isRelevant (greedy-source gate)', () => {
  const q = 'John Martin pandemonium painting';
  it('keeps a match on the most specific token', () => {
    expect(isRelevant({ title: 'Pandemonium Rex' }, q)).toBe(true);
  });
  it('drops single common-name noise', () => {
    expect(isRelevant({ title: 'John Braun' }, q)).toBe(false);
    expect(isRelevant({ title: 'Martin Tranmæl', artist: 'Harald Dal' }, q)).toBe(false);
    expect(isRelevant({ title: 'John Olsen, Osebol' }, q)).toBe(false);
    expect(isRelevant({ title: 'The Art of Painting The Passions I' }, q)).toBe(false);
  });
  it('keeps an artist match for a name query (diacritic + fuzzy)', () => {
    expect(isRelevant({ title: 'Skrik', artist: 'Edvard Munch' }, 'Edvard Munch')).toBe(true);
    expect(isRelevant({ title: 'Natt', artist: 'Harald Sohlberg' }, 'Harald Solberg')).toBe(true); // typo
  });
  it('keeps everything for an empty-ish query', () => {
    expect(isRelevant({ title: 'whatever' }, 'a')).toBe(true);
  });
});

describe('jaroWinkler', () => {
  it('scores name variants high and unrelated low', () => {
    expect(jaroWinkler('sohlberg', 'solberg')).toBeGreaterThan(0.9);
    expect(jaroWinkler('munch', 'munch')).toBe(1);
    expect(jaroWinkler('munch', 'tractor')).toBeLessThan(0.6);
  });
  it('rewards shared prefixes (Winkler)', () => {
    expect(jaroWinkler('rembrandt', 'rembrant')).toBeGreaterThan(jaroWinkler('rembrandt', 'xembrandt'));
  });
});

describe('relevanceScore with IDF', () => {
  it('a rare-token hit outranks a common-token hit', () => {
    // "pandemonium" is rare in the pool, "saint" is common → idf makes the rare hit win
    const idf = (t: string) => (t === 'pandemonium' ? 5 : 0.6);
    const rare = relevanceScore({ title: 'Pandemonium' }, 'saint pandemonium', idf);
    const common = relevanceScore({ title: 'Saint George' }, 'saint pandemonium', idf);
    expect(rare).toBeGreaterThan(common);
  });
});

describe('workKey', () => {
  it('groups the same work across sources, diacritic-folded', () => {
    expect(workKey({ title: 'The Scream', artist: 'Edvard Munch' }))
      .toBe(workKey({ title: 'Scream', artist: 'Edvard Munch' }));
  });
});

describe('fuse (reciprocal rank fusion)', () => {
  const mk = (id: string, source: string, title: string, artist = '', pd = true) =>
    ({ id, source, title, artist, isPublicDomain: pd });

  it('floats the exact-title match to the top regardless of source order', () => {
    const items = [
      mk('a', 'met', 'Study of a Seated Man'),       // met's #1, irrelevant
      mk('b', 'met', 'The Thinker', 'Auguste Rodin'), // met's #2, the real target
      mk('c', 'aic', 'The Kiss', 'Auguste Rodin'),
    ];
    const out = fuse(items, 'The Thinker');
    expect(out[0].id).toBe('b');
  });

  it('rewards cross-source consensus (same work from multiple museums)', () => {
    const items = [
      mk('m1', 'met', 'Sunflowers', 'Vincent van Gogh'),
      mk('a1', 'aic', 'Sunflowers', 'Vincent van Gogh'),   // same work, 2nd source
      mk('w1', 'wikidata', 'Irises', 'Vincent van Gogh'),  // single-source
    ];
    const out = fuse(items, 'Vincent van Gogh');
    expect(out[0].title).toBe('Sunflowers'); // consensus lifts it above the singleton
  });

  it('preserves each source ranking and de-interleaves nothing it should not', () => {
    const items = [mk('x', 'met', 'A'), mk('y', 'aic', 'B')];
    const out = fuse(items, 'zzz nomatch');
    expect(out).toHaveLength(2); // no crash, stable on a no-match query
  });
});

// Regression: "JW Waterhouse" surfaced a MoMA subway map at #1 and AIC's
// "Nighthawks"/"American Gothic" — fallback hits APIs return when a query doesn't
// match. The pipeline's global gate must drop them; fusion ranks the survivors.
describe('rankResults (full pipeline: dedup → gate → fuse)', () => {
  const mk = (id: string, source: string, title: string, artist = '') =>
    ({ id, source, title, artist, isPublicDomain: true });

  it('drops non-matching fallback hits, keeps the real matches', () => {
    const items = [
      mk('mo', 'moma', 'New York City Subway Diagram', 'Massimo Vignelli'),
      mk('ai', 'aic', 'Nighthawks', 'Edward Hopper'),
      mk('c1', 'commons', 'John William Waterhouse - Undine'),
      mk('c2', 'commons', 'John William Waterhouse - The Siren'),
      mk('d1', 'digitalnz', 'Lamia', 'John Waterhouse'),
    ];
    const out = rankResults(items, 'JW Waterhouse');
    const titles = out.map((o) => o.title);
    expect(titles).not.toContain('Nighthawks');
    expect(titles).not.toContain('New York City Subway Diagram');
    expect(titles).toHaveLength(3);
    // top result is a real Waterhouse work — by title OR artist (name-aware rank)
    expect(`${out[0].title} ${out[0].artist}`.toLowerCase()).toContain('waterhouse');
  });

  it('de-dups by id (keeps first)', () => {
    const items = [mk('x', 'met', 'A'), mk('x', 'aic', 'A duplicate'), mk('y', 'met', 'B')];
    expect(rankResults(items, '')).toHaveLength(2);
  });

  it('never empties: falls back to ungated when nothing matches', () => {
    const items = [mk('a', 'met', 'Sunflowers'), mk('b', 'aic', 'Irises')];
    expect(rankResults(items, 'zzzznomatch')).toHaveLength(2);
  });
});

describe('relevanceScore (ordering)', () => {
  it('a full-phrase title match outranks a single-token one', () => {
    const phrase = relevanceScore({ title: 'The Starry Night', artist: 'Vincent van Gogh' }, 'starry night');
    const oneToken = relevanceScore({ title: 'Night Fishing at Antibes' }, 'starry night'); // only "night"
    expect(phrase).toBeGreaterThan(oneToken);
  });
  it('weights the artist field for a name query', () => {
    const byArtist = relevanceScore({ title: 'Madonna', artist: 'Edvard Munch' }, 'Edvard Munch');
    const inTitle = relevanceScore({ title: 'Portrait of Edvard', artist: 'Anon' }, 'Edvard Munch');
    expect(byArtist).toBeGreaterThan(inTitle);
  });
  it('matches initials to the right person ("JW" → John William, not Yoshiki)', () => {
    const jww = relevanceScore({ title: 'John William Waterhouse - Undine' }, 'JW Waterhouse');
    const yoshiki = relevanceScore({ title: 'Subway Diagram', artist: 'Yoshiki Waterhouse' }, 'JW Waterhouse');
    expect(jww).toBeGreaterThan(yoshiki);
  });
  it('is diacritic-insensitive', () => {
    expect(relevanceScore({ artist: 'Harald Sohlberg' }, 'Harald Sohlberg')).toBeGreaterThan(0);
    expect(relevanceScore({ title: 'Tranmæl' }, 'tranmael')).toBeGreaterThan(0);
  });
  it('returns 0 for no match', () => {
    expect(relevanceScore({ title: 'A bowl of fruit', artist: 'Anon' }, 'submarine')).toBe(0);
  });
});
