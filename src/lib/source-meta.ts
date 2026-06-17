/**
 * Display metadata for sources — labels for the badge/chip UI and a stable
 * chip-ordering. Kept OUT of Finder.tsx so it can be type-checked and tested
 * against the @harpe/core source registry: both maps are keyed by
 * `DisplaySource`, so adding a new `SourceKey` without a label/order entry is a
 * COMPILE error here (not a silent "unlabeled, sorted last" UI degradation).
 * `source-meta.test.ts` additionally asserts runtime sync with `SOURCE_KEYS`.
 */
import type { SourceKey } from '@harpe/core';

// Backend source keys plus the two client-only pseudo-sources: `iiif` (a pasted
// IIIF manifest/info.json) and `scan` (images scraped from a web page).
export type DisplaySource = SourceKey | 'iiif' | 'scan';

/** Short label shown in the source badge + filter chips. */
export const SOURCE_LABELS: Record<DisplaySource, string> = {
  aic: 'AIC', met: 'Met', cleveland: 'Cleveland', commons: 'Commons', wikiart: 'WikiArt',
  vam: 'V&A', wellcome: 'Wellcome', smk: 'SMK', nasjonalmuseet: 'Nasjonalmus.', digitalnz: 'DigitalNZ',
  wikidata: 'Wikidata', europeana: 'Europeana', harvard: 'Harvard', si: 'Smithsonian',
  parismusees: 'Paris Musées', moma: 'MoMA', nga: 'NGA', mia: 'MIA', loc: 'Library of Congress',
  nypl: 'NYPL', iiif: 'IIIF', scan: 'Web page',
};

/** Stable display order for the source-filter chips (lower = first). Result
 *  ranking itself is handled by the RRF `fuse`; this only orders the chips. */
export const SOURCE_ORDER: Record<DisplaySource, number> = {
  aic: 0, met: 1, cleveland: 2, vam: 3, wellcome: 4, smk: 5, nasjonalmuseet: 6,
  parismusees: 7, harvard: 8, europeana: 9, si: 10, moma: 11, nga: 12, mia: 13, loc: 14,
  nypl: 15, wikidata: 16, digitalnz: 17, wikiart: 18, commons: 19, iiif: 20, scan: 21,
};
