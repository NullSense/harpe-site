import { describe, it, expect } from 'vitest';
import { previewImage } from '../../middleware.js';

const ORIGIN = 'https://harpe-site.vercel.app';

// The preview image must always end up small + same-origin so strict crawlers
// (Signal caps at 1 MiB) and huge paintings still render a card.
describe('previewImage', () => {
  it('wraps a huge external original through the resize proxy (≤1200 jpeg)', () => {
    const r = previewImage(ORIGIN, 'https://ms.museum.org/iiif/huge.tif/full/full/0/default.jpg');
    expect(r.type).toBe('image/jpeg');
    expect(r.url).toContain(`${ORIGIN}/api/fetch?url=`);
    expect(r.url).toContain('w=1200');
    expect(r.url).toContain('fmt=jpeg');
    expect(decodeURIComponent(r.url)).toContain('ms.museum.org');
  });

  it('unwraps an already-proxied URL and re-caps at 1200 (no double proxy)', () => {
    const r = previewImage(ORIGIN, '/api/fetch?url=' + encodeURIComponent('https://x/orig.jpg') + '&w=2560');
    expect(r.url).toBe(`${ORIGIN}/api/fetch?url=${encodeURIComponent('https://x/orig.jpg')}&w=1200&fmt=jpeg&q=80`);
    // exactly one /api/fetch — not nested
    expect(r.url.match(/\/api\/fetch/g)?.length).toBe(1);
  });

  it('falls back to the default site image when none is given', () => {
    const r = previewImage(ORIGIN, '');
    expect(r.url).toBe(`${ORIGIN}/logo-bronze.png`);
    expect(r.type).toBe('image/png');
  });

  it('leaves a non-proxy same-origin asset as an absolute URL', () => {
    const r = previewImage(ORIGIN, '/logo-bronze.png');
    expect(r.url).toBe(`${ORIGIN}/logo-bronze.png`);
  });

  it('returns the default image for a malformed url', () => {
    const r = previewImage(ORIGIN, 'http://[not a url');
    expect(r.url).toBe(`${ORIGIN}/logo-bronze.png`);
  });
});
