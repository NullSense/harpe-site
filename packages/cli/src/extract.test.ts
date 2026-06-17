import { describe, it, expect } from 'vitest';
import { collect, wmOriginal, sizeHint, select, type Probed } from './extract';

// Ported from harpe tests/test_extract.py + test_select.py.
describe('wmOriginal', () => {
  it('maps a Wikimedia thumb to its original', () => {
    const thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/John_Martin_-_Macbeth.jpg/960px-John_Martin_-_Macbeth.jpg';
    const orig = 'https://upload.wikimedia.org/wikipedia/commons/c/ce/John_Martin_-_Macbeth.jpg';
    expect(wmOriginal(thumb)).toBe(orig);
  });
  it('passes a non-thumb URL through', () => {
    expect(wmOriginal('https://example.org/a/b/photo.jpg')).toBe('https://example.org/a/b/photo.jpg');
  });
});

describe('sizeHint', () => {
  it('reads width from query, /NNNpx- segment, or descriptor', () => {
    expect(sizeHint('https://x/i.jpg?w=2000')).toBe(2000);
    expect(sizeHint('https://x/640px-i.jpg')).toBe(640);
    expect(sizeHint('https://x/i.jpg', 1500)).toBe(1500);
  });
});

describe('collect', () => {
  it('dedupes Wikimedia variants to one original', () => {
    const html = `
      <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/A.jpg/330px-A.jpg"
           srcset="https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/A.jpg/660px-A.jpg 2x">`;
    expect(collect(html, 'https://en.wikipedia.org/')).toEqual([
      'https://upload.wikimedia.org/wikipedia/commons/c/ce/A.jpg',
    ]);
  });

  it('absolutizes relative URLs and skips data: URIs', () => {
    const html = '<img src="/img/a.png"><img src="data:image/png;base64,xxxx">';
    expect(collect(html, 'https://site.test/page')).toEqual(['https://site.test/img/a.png']);
  });

  it('picks the largest query-size variant of the same path', () => {
    const html = '<img src="https://cdn.test/p.jpg?w=400"><img src="https://cdn.test/p.jpg?w=1600">';
    expect(collect(html, 'https://cdn.test/')).toEqual(['https://cdn.test/p.jpg?w=1600']);
  });
});

describe('select', () => {
  const P = (url: string, verdict: Probed['verdict'], size?: [number, number]): Probed => ({ url, verdict, size });

  it('ranks by pixel area, drops non-images, keeps unknowns last', () => {
    const rows = select([
      P('big', 'ok', [4000, 3000]),
      P('small', 'ok', [200, 150]),
      P('html', 'drop'),
      P('mystery', 'image'),
    ], 100);
    expect(rows.map((r) => r.url)).toEqual(['big', 'small', 'mystery']);
    expect(rows[0].dim).toBe('4000x3000');
  });

  it('relaxes the floor rather than returning an empty list', () => {
    const rows = select([P('tiny', 'ok', [60, 60])], 100);
    expect(rows.map((r) => r.url)).toEqual(['tiny']); // would be dropped by minpx, but kept
  });
});
