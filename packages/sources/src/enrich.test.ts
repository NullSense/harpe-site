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

import { enrichCommonsWikidataIds } from './adapters.js';

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
const p6243 = (qid: string) => ({
  P6243: [{
    mainsnak: {
      snaktype: 'value', property: 'P6243', datatype: 'wikibase-item',
      datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', 'numeric-id': Number(qid.slice(1)), id: qid } },
    },
    type: 'statement', rank: 'normal',
  }],
});

beforeEach(() => timedFetchMock.mockReset());

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
});
