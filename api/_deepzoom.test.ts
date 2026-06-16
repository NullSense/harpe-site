import { describe, it, expect } from 'vitest';
import { findDescriptorUrls, descriptorKind, isGoogleArtsAndCulture } from '../src/lib/server/deepzoom-detect.js';

describe('descriptorKind', () => {
  it('classifies descriptor URLs by suffix', () => {
    expect(descriptorKind('https://h/x/info.json')).toBe('iiif');
    expect(descriptorKind('https://h/image.dzi')).toBe('dzi');
    expect(descriptorKind('https://h/img/ImageProperties.xml')).toBe('zoomify');
    expect(descriptorKind('https://h/img/ImageProperties.xml?v=2')).toBe('zoomify');
    expect(descriptorKind('https://h/page.html')).toBeNull();
  });
});

describe('isGoogleArtsAndCulture', () => {
  it('matches the GA&C host only', () => {
    expect(isGoogleArtsAndCulture('https://artsandculture.google.com/asset/x')).toBe(true);
    expect(isGoogleArtsAndCulture('https://www.artsandculture.google.com/asset/x')).toBe(true);
    expect(isGoogleArtsAndCulture('https://artic.edu/x')).toBe(false);
    expect(isGoogleArtsAndCulture('not a url')).toBe(false);
  });
});

describe('findDescriptorUrls', () => {
  const base = 'https://example.org/viewer';

  it('finds a DZI referenced with a relative path', () => {
    const html = `<div data-dzi="/tiles/painting.dzi"></div>`;
    expect(findDescriptorUrls(html, base)).toContainEqual({ url: 'https://example.org/tiles/painting.dzi', protocol: 'dzi' });
  });

  it('finds an absolute IIIF info.json', () => {
    const html = `OpenSeadragon({ tileSources: "https://i.museum.org/iiif/abc/info.json" })`;
    expect(findDescriptorUrls(html, base)).toContainEqual({ url: 'https://i.museum.org/iiif/abc/info.json', protocol: 'iiif' });
  });

  it('finds a Zoomify ImageProperties.xml', () => {
    const html = `<param name="zoomifyImagePath" value="https://z.org/img/ImageProperties.xml">`;
    expect(findDescriptorUrls(html, base)).toContainEqual({ url: 'https://z.org/img/ImageProperties.xml', protocol: 'zoomify' });
  });

  it('dedupes and returns nothing for a plain page', () => {
    expect(findDescriptorUrls('<p>just text, no tiles</p>', base)).toHaveLength(0);
    const dup = `"a.dzi" "a.dzi"`;
    expect(findDescriptorUrls(dup, base).filter((d) => d.protocol === 'dzi')).toHaveLength(1);
  });
});
