import { describe, it, expect } from 'vitest';
import { normalize, tokenize, looksLikeName, within1, jaroWinkler, relevanceScore, isRelevant, workKey, fuse, rankResults, dedupe, imageIdentity } from './search';

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
  it('strips a trailing museum accession code', () => {
    expect(workKey({ title: 'Boleslaw at the Golden Gate in Kyiv MNK ND 11610', artist: 'Jan Matejko' }))
      .toBe(workKey({ title: 'Boleslaw at the Golden Gate in Kyiv', artist: 'Jan Matejko' }));
  });
  it('strips keyword accession codes (inv. / no.)', () => {
    expect(workKey({ title: 'Sunflowers, inv. 1888.4', artist: 'Vincent van Gogh' }))
      .toBe(workKey({ title: 'Sunflowers', artist: 'Vincent van Gogh' }));
  });
  it('folds a "(detail)" crop onto the full work', () => {
    expect(workKey({ title: 'Battle of Grunwald (detail)', artist: 'Jan Matejko' }))
      .toBe(workKey({ title: 'Battle of Grunwald', artist: 'Jan Matejko' }));
  });
  it('does NOT eat a real word that looks code-ish but is lowercase', () => {
    // "in Kyiv" must survive — only ALL-CAPS trailing codes are stripped.
    expect(workKey({ title: 'The Golden Gate in Kyiv', artist: 'Jan Matejko' }))
      .not.toBe(workKey({ title: 'The Golden Gate', artist: 'Jan Matejko' }));
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

// ─── thematic / subject queries (tags + description, not just title) ────────────

describe('thematic queries match subject fields, not only title/artist', () => {
  // The bug: "mythology and gods" returned ~22 works because the gate only saw
  // title+artist, dropping every mythological painting titled "Venus and Mars".
  const venus = {
    title: 'Venus and Mars', artist: 'Sandro Botticelli',
    tags: ['mythology', 'Roman gods', 'Venus', 'Mars'],
    description: 'An allegory of love depicting the Roman gods Venus and Mars.',
  };
  const portrait = { title: 'Portrait of a Lady', artist: 'Hans Holbein', tags: ['portrait'], description: 'A noblewoman.' };

  it('keeps a mythological work whose theme is only in tags/description', () => {
    expect(isRelevant(venus, 'mythology and gods')).toBe(true);
  });

  it('still drops a work with no thematic match (gate not neutered)', () => {
    expect(isRelevant(portrait, 'mythology and gods')).toBe(false);
  });

  it('scores the thematic match above zero so it can rank', () => {
    expect(relevanceScore(venus, 'mythology and gods')).toBeGreaterThan(0);
    expect(relevanceScore(portrait, 'mythology and gods')).toBe(0);
  });

  it('filters out Internet-Archive book-scan plates but keeps real works', () => {
    const items = [
      { id: 'b1', source: 'commons', title: 'The gods of the Egyptians (1904) (14763839232)', tags: ['mythology'] },
      { id: 'b2', source: 'commons', title: 'The gods of the Egyptians (1904) (14577696327)', tags: ['mythology'] },
      { id: 'v', source: 'aic', title: 'Venus and Mars', artist: 'Botticelli', tags: ['mythology', 'gods'] },
    ];
    const out = rankResults(items, 'mythology and gods');
    expect(out.map((o) => o.title)).toEqual(['Venus and Mars']); // book plates dropped
  });

  it('keeps book scans when the query is actually about books/illustrations', () => {
    const items = [
      { id: 'b1', source: 'commons', title: 'Egyptian mythology illustrations (1904) (14763839232)', tags: ['mythology'] },
    ];
    const out = rankResults(items, 'egyptian mythology book illustrations');
    expect(out).toHaveLength(1);
  });

  it('rankResults keeps thematic matches instead of gating them out', () => {
    const items = [
      { id: '1', source: 'aic', ...venus },
      { id: '2', source: 'met', title: 'The Birth of Venus', artist: 'Botticelli', tags: ['mythology', 'goddess'], description: 'The goddess Venus.' },
      { id: '3', source: 'cleveland', ...portrait },
    ];
    const out = rankResults(items, 'mythology and gods');
    const titles = out.map((o) => o.title);
    expect(titles).toContain('Venus and Mars');
    expect(titles).toContain('The Birth of Venus');
    expect(titles).not.toContain('Portrait of a Lady');
  });
});

// ─── cross-source de-duplication ───────────────────────────────────────────────

type Item = {
  id: string; source: string; title?: string; artist?: string;
  thumbUrl?: string; previewUrl?: string; fullUrl?: string;
  width?: number; height?: number;
  date?: string; medium?: string; tags?: string[]; downloads?: unknown[];
  wikidataId?: string; artistId?: string; depicts?: string[]; depictsLabels?: string[]; clusterId?: number; movement?: string; nbSitelinks?: number;
  // set at runtime by dedupe()
  dupCount?: number; mergedSources?: string[]; mergedIds?: string[];
  variants?: Array<{ source: string; date?: string; medium?: string }>;
};
const mk = (o: Partial<Item> & { id: string; source: string }): Item => o;

describe('imageIdentity', () => {
  it('keys a Commons original and its thumb to the same file', () => {
    const orig = imageIdentity({ fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Mona_Lisa.jpg' });
    const thumb = imageIdentity({ fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Mona_Lisa.jpg/843px-Mona_Lisa.jpg' });
    expect(orig).toBe('commons:mona_lisa.jpg');
    expect(thumb).toBe('commons:mona_lisa.jpg');
  });
  it('keys a Wikidata Special:FilePath URL to the same Commons file', () => {
    expect(imageIdentity({ fullUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mona_Lisa.jpg?width=843' }))
      .toBe('commons:mona_lisa.jpg');
  });
  it('keys an IIIF image by its identifier base, ignoring the size segment', () => {
    const a = imageIdentity({ fullUrl: 'https://iiif.example.org/abc123/full/full/0/default.jpg' });
    const b = imageIdentity({ fullUrl: 'https://iiif.example.org/abc123/full/!843,843/0/default.jpg' });
    expect(a).toBe(b);
    expect(a).toBe('iiif:https://iiif.example.org/abc123');
  });
  it('falls back to the URL without query/fragment, and empty for no image', () => {
    expect(imageIdentity({ fullUrl: 'https://cdn.museum.org/x/y.jpg?token=1#frag' })).toBe('https://cdn.museum.org/x/y.jpg');
    expect(imageIdentity({})).toBe('');
  });
});

describe('dedupe', () => {
  it('collapses the same Commons file surfaced by Commons and Wikidata', () => {
    const out = dedupe([
      mk({ id: 'commons-1', source: 'commons', title: 'Mona Lisa', artist: 'Leonardo', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Mona_Lisa.jpg' }),
      mk({ id: 'wikidata-Q12', source: 'wikidata', title: 'Mona Lisa', artist: 'Leonardo da Vinci', fullUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mona_Lisa.jpg?width=843' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dupCount).toBe(2);
    expect(new Set(out[0].mergedSources)).toEqual(new Set(['commons', 'wikidata']));
  });

  it('records every folded id on the survivor (deep-link ?v= must survive a rep change)', () => {
    // The shared link points at the wikidata id, but a larger Commons scan wins
    // the representative slot → survivor.id is the Commons one. The wikidata id
    // must still be matchable via mergedIds so the deep link reopens the card.
    const out = dedupe([
      mk({ id: 'wd-Q119007077', source: 'wikidata', title: 'School of Athens', artist: 'Mengs', fullUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/sa.jpg', wikidataId: 'Q119007077' }),
      mk({ id: 'commons-22169893', source: 'commons', title: 'School of Athens', artist: 'Anton Raphael Mengs', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/5/5b/sa.jpg', wikidataId: 'Q119007077', width: 4000, height: 3000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('commons-22169893'); // larger image won the rep slot
    expect(new Set(out[0].mergedIds)).toEqual(new Set(['wd-Q119007077', 'commons-22169893']));
  });

  it('leaves mergedIds undefined for a singleton (no merge happened)', () => {
    const out = dedupe([mk({ id: 'solo-1', source: 'met', title: 'Unique Work', artist: 'Nobody', fullUrl: 'https://m/u.jpg' })]);
    expect(out).toHaveLength(1);
    expect(out[0].mergedIds).toBeUndefined();
  });

  it('collapses the same work from different museums (different scans) and merges metadata', () => {
    const out = dedupe([
      mk({ id: 'met-1', source: 'met', title: 'The Starry Night', artist: 'Vincent van Gogh', fullUrl: 'https://images.metmuseum.org/sn.jpg', width: 600, height: 480, date: '1889', tags: ['landscape'] }),
      mk({ id: 'europeana-9', source: 'europeana', title: 'The Starry Night', artist: 'Vincent van Gogh', fullUrl: 'https://europeana.eu/sn-big.jpg', width: 4000, height: 3200, medium: 'Oil on canvas', tags: ['night'] }),
    ]);
    expect(out).toHaveLength(1);
    // representative = the higher-resolution image…
    expect(out[0].fullUrl).toContain('europeana');
    // …but metadata from BOTH is preserved
    expect(out[0].date).toBe('1889');
    expect(out[0].medium).toBe('Oil on canvas');
    expect(new Set(out[0].tags)).toEqual(new Set(['landscape', 'night']));
    expect(out[0].dupCount).toBe(2);
  });

  it('merges the same work across artist name variants (subset of tokens)', () => {
    const out = dedupe([
      mk({ id: 'a', source: 'met', title: 'Wheatfield with Crows', artist: 'van Gogh', fullUrl: 'https://m/a.jpg', width: 100, height: 80 }),
      mk({ id: 'b', source: 'europeana', title: 'Wheatfield with Crows', artist: 'Vincent van Gogh', fullUrl: 'https://m/b.jpg', width: 4000, height: 3000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dupCount).toBe(2);
  });

  it('folds the SAME painting across languages via Wikidata QID (different files + titles)', () => {
    // The cross-language case: a Polish-titled Commons scan, an English-titled
    // Commons scan, and the Wikidata item — different files, different titles, no
    // shared artist spelling — all carry the same artwork QID, so they collapse.
    const out = dedupe([
      mk({ id: 'commons-1', source: 'commons', title: 'Bitwa pod Grunwaldem', artist: 'Jan Matejko', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/3/38/Grunwald_pl.jpg', wikidataId: 'Q1144558', width: 1280, height: 800 }),
      mk({ id: 'commons-2', source: 'commons', title: 'Battle of Grunwald', artist: 'Matejko', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/99/Grunwald_en.jpg', wikidataId: 'Q1144558', width: 4000, height: 2500 }),
      mk({ id: 'wikidata-Q1144558', source: 'wikidata', title: 'The Battle of Grunwald', artist: 'Jan Matejko', fullUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/wd.jpg' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dupCount).toBe(2); // commons + wikidata (2 distinct sources)
    expect(out[0].fullUrl).toContain('Grunwald_en'); // largest image wins
    expect(out[0].wikidataId).toBe('Q1144558');
  });

  it('unions a Commons file (QID via Structured Data) with a wikidata-Q id', () => {
    const out = dedupe([
      mk({ id: 'commons-77', source: 'commons', title: 'A detail crop', artist: 'X', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Crop.jpg', wikidataId: 'Q42' }),
      mk({ id: 'wikidata-Q42', source: 'wikidata', title: 'Whole Work', artist: 'X', fullUrl: 'https://m/whole.jpg' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('folds no-QID copies that share an offline cluster_id (different files + titles)', () => {
    // Two different photographs of one painting, no shared QID/file, cross-language
    // titles — only the precomputed cluster_id links them.
    const out = dedupe([
      mk({ id: 'wikiart-1', source: 'wikiart', title: 'Bitwa pod Grunwaldem', artist: 'Matejko', fullUrl: 'https://wikiart/a.jpg', clusterId: 7, width: 800, height: 500 }),
      mk({ id: 'commons-2', source: 'commons', title: 'Battle of Grunwald', artist: 'Jan Matejko', fullUrl: 'https://commons/b.jpg', clusterId: 7, width: 4000, height: 2500 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dupCount).toBe(2);
  });

  it('different cluster_ids do NOT merge; null cluster_id is a singleton', () => {
    const out = dedupe([
      mk({ id: 'a', source: 'met', title: 'Sunset over the Lagoon', artist: 'A', fullUrl: 'https://m/a.jpg', clusterId: 9 }),
      mk({ id: 'b', source: 'aic', title: 'Portrait of a Banker', artist: 'B', fullUrl: 'https://m/b.jpg', clusterId: 10 }),
      mk({ id: 'c', source: 'commons', title: 'Lone Work', artist: 'C', fullUrl: 'https://m/c.jpg' }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('union-merges depicts QIDs across folded copies', () => {
    const out = dedupe([
      mk({ id: 'commons-1', source: 'commons', title: 'The Night Watch', artist: 'Rembrandt', fullUrl: 'https://m/a.jpg', wikidataId: 'Q219831', depicts: ['Q5'], width: 100, height: 80 }),
      mk({ id: 'wikidata-Q219831', source: 'wikidata', title: 'The Night Watch', artist: 'Rembrandt', fullUrl: 'https://m/b.jpg', depicts: ['Q12271', 'Q5'], width: 4000, height: 3000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(new Set(out[0].depicts)).toEqual(new Set(['Q5', 'Q12271']));
  });

  it('rebuilds index-aligned depictsLabels from all copies (no raw-QID fallback)', () => {
    const out = dedupe([
      // representative (larger) knows only "human figure"; the other copy has the cat label
      mk({ id: 'wikidata-Q219831', source: 'wikidata', title: 'The Night Watch', artist: 'Rembrandt', fullUrl: 'https://m/b.jpg', depicts: ['Q12271'], depictsLabels: ['human figure'], width: 4000, height: 3000 }),
      mk({ id: 'commons-1', source: 'commons', title: 'The Night Watch', artist: 'Rembrandt', fullUrl: 'https://m/a.jpg', wikidataId: 'Q219831', depicts: ['Q146'], depictsLabels: ['cat'], width: 100, height: 80 }),
    ]);
    expect(out).toHaveLength(1);
    const map = Object.fromEntries((out[0].depicts ?? []).map((q, i) => [q, out[0].depictsLabels![i]]));
    expect(map).toEqual({ Q12271: 'human figure', Q146: 'cat' }); // every QID has its label
  });

  it('does NOT merge an attribution copy ("after Rembrandt") with the master', () => {
    const out = dedupe([
      mk({ id: 'a', source: 'met', title: 'Self-Portrait', artist: 'Rembrandt van Rijn', fullUrl: 'https://m/a.jpg', width: 100, height: 80 }),
      mk({ id: 'b', source: 'aic', title: 'Self-Portrait', artist: 'after Rembrandt van Rijn', fullUrl: 'https://m/b.jpg', width: 4000, height: 3000 }),
    ]);
    expect(out).toHaveLength(2); // the copy stays separate from the original
  });

  it('never merges on an empty / missing QID', () => {
    const out = dedupe([
      mk({ id: 'commons-1', source: 'commons', title: 'Thing One', artist: 'A', fullUrl: 'https://m/1.jpg' }),
      mk({ id: 'commons-2', source: 'commons', title: 'Thing Two', artist: 'B', fullUrl: 'https://m/2.jpg' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does NOT merge distinct "Untitled" works by the same artist', () => {
    const out = dedupe([
      mk({ id: 'a', source: 'moma', title: 'Untitled', artist: 'Donald Judd', fullUrl: 'https://m/a.jpg' }),
      mk({ id: 'b', source: 'moma', title: 'Untitled', artist: 'Donald Judd', fullUrl: 'https://m/b.jpg' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does NOT merge same-title works with different artists', () => {
    const out = dedupe([
      mk({ id: 'a', source: 'aic', title: 'Composition', artist: 'Piet Mondrian', fullUrl: 'https://m/a.jpg' }),
      mk({ id: 'b', source: 'aic', title: 'Composition', artist: 'Wassily Kandinsky', fullUrl: 'https://m/b.jpg' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does NOT merge same-title works when artist is missing', () => {
    const out = dedupe([
      mk({ id: 'a', source: 'loc', title: 'River scene', artist: '', fullUrl: 'https://m/a.jpg' }),
      mk({ id: 'b', source: 'loc', title: 'River scene', artist: '', fullUrl: 'https://m/b.jpg' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('merges transitively: A≡B by image, B≡C by work → one item from 3 sources', () => {
    const out = dedupe([
      mk({ id: 'commons-1', source: 'commons', title: 'The Kiss', artist: 'Gustav Klimt', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/c2/Klimt_Kiss.jpg' }),
      mk({ id: 'wikidata-1', source: 'wikidata', title: 'The Kiss', artist: 'Gustav Klimt', fullUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Klimt_Kiss.jpg' }),
      mk({ id: 'europeana-1', source: 'europeana', title: 'The Kiss', artist: 'Gustav Klimt', fullUrl: 'https://europeana.eu/kiss.jpg', width: 5000, height: 5000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dupCount).toBe(3);
  });

  it('unions tags and concatenates downloads, deduping tags', () => {
    const out = dedupe([
      mk({ id: 'a', source: 'met', title: 'Wave', artist: 'Hokusai', fullUrl: 'https://iiif.x/w/full/full/0/default.jpg', width: 100, height: 80, tags: ['ukiyo-e', 'sea'], downloads: [{ url: 'a' }] }),
      mk({ id: 'b', source: 'aic', title: 'Wave', artist: 'Hokusai', fullUrl: 'https://iiif.x/w/full/!843,843/0/default.jpg', width: 200, height: 160, tags: ['sea', 'woodblock'], downloads: [{ url: 'b' }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(new Set(out[0].tags)).toEqual(new Set(['ukiyo-e', 'sea', 'woodblock']));
    expect(out[0].downloads).toHaveLength(2);
  });

  it('is stable: a merged group keeps its earliest position', () => {
    const out = dedupe([
      mk({ id: 'x', source: 'aic', title: 'Solo One', artist: 'A', fullUrl: 'https://m/x.jpg' }),
      mk({ id: 'dup-a', source: 'commons', title: 'Pair', artist: 'B', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/d/d4/Pair.jpg' }),
      mk({ id: 'y', source: 'met', title: 'Solo Two', artist: 'C', fullUrl: 'https://m/y.jpg' }),
      mk({ id: 'dup-b', source: 'wikidata', title: 'Pair', artist: 'B', fullUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Pair.jpg' }),
    ]);
    expect(out.map((o) => o.title)).toEqual(['Solo One', 'Pair', 'Solo Two']);
  });

  it('retains each source\'s record in variants for the AI analysis', () => {
    const out = dedupe([
      mk({ id: 'met-1', source: 'met', title: 'The Starry Night', artist: 'Vincent van Gogh', fullUrl: 'https://m/a.jpg', width: 100, height: 80, date: '1889' }),
      mk({ id: 'eu-1', source: 'europeana', title: 'The Starry Night', artist: 'Vincent van Gogh', fullUrl: 'https://m/b.jpg', width: 4000, height: 3000, medium: 'Oil on canvas' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].variants).toHaveLength(2);
    expect(new Set(out[0].variants!.map((v) => v.source))).toEqual(new Set(['met', 'europeana']));
    // each variant keeps its own source's distinct fact
    expect(out[0].variants!.find((v) => v.source === 'met')?.date).toBe('1889');
    expect(out[0].variants!.find((v) => v.source === 'europeana')?.medium).toBe('Oil on canvas');
  });

  it('does not attach variants to a non-merged (singleton) item', () => {
    const out = dedupe([mk({ id: 'solo', source: 'aic', title: 'Lone', artist: 'A', fullUrl: 'https://m/x.jpg' })]);
    expect(out[0].variants).toBeUndefined();
  });

  it('passes through a single item or empty list unchanged', () => {
    expect(dedupe([])).toEqual([]);
    const one = [mk({ id: 'a', source: 'aic', title: 'X', artist: 'Y', fullUrl: 'https://m/a.jpg' })];
    expect(dedupe(one)).toHaveLength(1);
  });
});

describe('rankResults de-duplicates end to end', () => {
  it('collapses cross-source duplicates and keeps a single ranked card', () => {
    const ranked = rankResults([
      mk({ id: 'commons-1', source: 'commons', title: 'The Night Watch', artist: 'Rembrandt', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/n/nw/Night_Watch.jpg' }),
      mk({ id: 'wikidata-1', source: 'wikidata', title: 'The Night Watch', artist: 'Rembrandt', fullUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Night_Watch.jpg' }),
      mk({ id: 'europeana-1', source: 'europeana', title: 'The Night Watch', artist: 'Rembrandt van Rijn', fullUrl: 'https://europeana.eu/nw.jpg', width: 5000, height: 4000 }),
    ], 'night watch rembrandt');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].dupCount).toBe(3);
  });
});
