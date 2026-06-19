import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtItem } from '@harpe/core';

// Guards the Commons Structured-Data → Wikidata-QID enrichment that feeds the
// cross-language fold in dedupe(). `timedFetch` (which uses undici's fetch, not
// the global) is mocked so no network runs; the dedup union itself is covered in
// @harpe/core search.test.ts.

const { timedFetchMock } = vi.hoisted(() => ({ timedFetchMock: vi.fn() }));
vi.mock('./helpers.js', async (orig) => ({
  ...(await orig<typeof import('./helpers.js')>()),
  timedFetch: timedFetchMock,
}));

import { enrichCommonsWikidataIds, _resetEntityBucketCache } from './adapters.js';

function item(id: string, source = 'commons'): ArtItem {
  return {
    id, title: 't', artist: '', dimensions: '',
    thumbUrl: 'https://x/t.jpg', previewUrl: 'https://x/p.jpg', fullUrl: 'https://x/f.jpg',
    format: 'jpeg', lossless: false, downloads: [], source, isPublicDomain: true,
  };
}
const sig = () => new AbortController().signal;
const reply = (entities: unknown) => ({ ok: true, json: async () => ({ entities }) });

// A realistic P6243 "digital representation of" statement (wikibase-entityid snak),
// the shape `simplifyClaims` expects.
const snak = (property: string, qid: string) => ({
  mainsnak: {
    snaktype: 'value', property, datatype: 'wikibase-item',
    datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', 'numeric-id': Number(qid.slice(1)), id: qid } },
  },
  type: 'statement', rank: 'normal',
});
const p6243 = (qid: string) => ({ P6243: [snak('P6243', qid)] });
const p180 = (...qids: string[]) => ({ P180: qids.map((q) => snak('P180', q)) });

beforeEach(() => { timedFetchMock.mockReset(); _resetEntityBucketCache(); });

describe('enrichCommonsWikidataIds', () => {
  it('sets wikidataId from P6243 (digital representation of)', async () => {
    timedFetchMock.mockResolvedValue(reply({ M111: { statements: p6243('Q1144558') } }));
    const items = [item('commons-111')];
    await enrichCommonsWikidataIds(items, sig());
    expect(items[0].wikidataId).toBe('Q1144558');
  });

  it('handles the older `claims` key as well as `statements`', async () => {
    timedFetchMock.mockResolvedValue(reply({ M112: { claims: p6243('Q7') } }));
    const items = [item('commons-112')];
    await enrichCommonsWikidataIds(items, sig());
    expect(items[0].wikidataId).toBe('Q7');
  });

  it('leaves items unchanged when the file has no P6243', async () => {
    timedFetchMock.mockResolvedValue(reply({ M222: { statements: {} } }));
    const items = [item('commons-222')];
    await enrichCommonsWikidataIds(items, sig());
    expect(items[0].wikidataId).toBeUndefined();
  });

  it('is best-effort: a non-ok response never throws', async () => {
    timedFetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const items = [item('commons-333')];
    await expect(enrichCommonsWikidataIds(items, sig())).resolves.toBeUndefined();
    expect(items[0].wikidataId).toBeUndefined();
  });

  it('is best-effort: a malformed response body never throws', async () => {
    timedFetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('bad json'); } });
    const items = [item('commons-444')];
    await expect(enrichCommonsWikidataIds(items, sig())).resolves.toBeUndefined();
    expect(items[0].wikidataId).toBeUndefined();
  });

  it('never calls the API for non-Commons items', async () => {
    await enrichCommonsWikidataIds([item('wikiart-5', 'wikiart'), item('aic-9', 'aic')], sig());
    expect(timedFetchMock).not.toHaveBeenCalled();
  });

  it('adds depicts pills from SDC P180, labels resolved from our subject shards (known subjects only)', async () => {
    // The SAME claims fetch carries P180; labels come from our depicts shards (no
    // Wikidata call). Only subjects in our KG survive — their pill links to a real
    // /api/depicts page; an unknown QID (Q999) is dropped rather than dead-ending.
    timedFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes('/data/depicts/')) {
        return Promise.resolve({ ok: true, json: async () => ({ Q146: { qid: 'Q146', labelEn: 'cat', workCount: 3 } }) });
      }
      return Promise.resolve(reply({ M555: { statements: p180('Q146', 'Q999') } }));
    });
    const items = [item('commons-555')];
    await enrichCommonsWikidataIds(items, sig());
    expect(items[0].depicts).toEqual(['Q146']);        // Q999 not in our KG → dropped
    expect(items[0].depictsLabels).toEqual(['cat']);
  });

  it('does not override depicts that a dump row already carries', async () => {
    timedFetchMock.mockImplementation((url: unknown) =>
      String(url).includes('/data/depicts/')
        ? Promise.resolve({ ok: true, json: async () => ({ Q146: { qid: 'Q146', labelEn: 'cat', workCount: 1 } }) })
        : Promise.resolve(reply({ M556: { statements: p180('Q146') } })));
    const items = [{ ...item('commons-556'), depicts: ['Q42'], depictsLabels: ['answer'] }];
    await enrichCommonsWikidataIds(items, sig());
    expect(items[0].depicts).toEqual(['Q42']); // untouched
  });
});
