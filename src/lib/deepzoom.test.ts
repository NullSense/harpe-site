import { describe, it, expect } from 'vitest';
import {
  type DeepZoomDescriptor,
  maxLevel,
  levelScale,
  levelDimensions,
  levelTiles,
  zoomifyTileGroup,
  tileUrl,
  thumbLevel,
  stitchLevel,
  osdTileSource,
} from './deepzoom';

const dzi = (over: Partial<DeepZoomDescriptor> = {}): DeepZoomDescriptor => ({
  protocol: 'dzi',
  width: 4000,
  height: 3000,
  tileSize: 254,
  overlap: 1,
  format: 'jpg',
  base: 'https://h/img',
  ...over,
});

const zoom = (over: Partial<DeepZoomDescriptor> = {}): DeepZoomDescriptor => ({
  protocol: 'zoomify',
  width: 4000,
  height: 3000,
  tileSize: 256,
  overlap: 0,
  format: 'jpg',
  base: 'https://h/zoom',
  ...over,
});

describe('pyramid math', () => {
  it('maxLevel is ceil(log2(longEdge))', () => {
    expect(maxLevel({ width: 4000, height: 3000 })).toBe(12); // 2^12 = 4096 ≥ 4000
    expect(maxLevel({ width: 256, height: 256 })).toBe(8);
    expect(maxLevel({ width: 1, height: 1 })).toBe(0);
  });

  it('levelScale halves per level down from the top', () => {
    const d = dzi();
    expect(levelScale(d, maxLevel(d))).toBe(1);
    expect(levelScale(d, maxLevel(d) - 1)).toBe(0.5);
    expect(levelScale(d, maxLevel(d) - 2)).toBe(0.25);
  });

  it('top level is the full image dimensions', () => {
    const d = dzi();
    expect(levelDimensions(d, maxLevel(d))).toEqual({ w: 4000, h: 3000 });
  });

  it('tile grid covers the level', () => {
    const d = dzi(); // 4000×3000, tile 254 → ceil(4000/254)=16, ceil(3000/254)=12
    expect(levelTiles(d, maxLevel(d))).toEqual({ cols: 16, rows: 12 });
  });
});

describe('tileUrl', () => {
  it('DZI uses _files/{level}/{col}_{row}.fmt', () => {
    const d = dzi();
    expect(tileUrl(d, 12, 3, 2)).toBe('https://h/img_files/12/3_2.jpg');
  });

  it('Zoomify uses TileGroup{g}/{level}-{col}-{row}.fmt', () => {
    const d = zoom();
    // level 0 is a single tile → group 0
    expect(tileUrl(d, 0, 0, 0)).toBe('https://h/zoom/TileGroup0/0-0-0.jpg');
  });

  it('Zoomify TileGroup buckets by 256 across the pyramid', () => {
    const d = zoom();
    // levels 0..N each contribute cols*rows tiles before the top level; the very
    // first top-level tile index = sum of all lower levels' tile counts.
    const ml = maxLevel(d);
    let below = 0;
    for (let l = 0; l < ml; l++) {
      const { cols, rows } = levelTiles(d, l);
      below += cols * rows;
    }
    expect(zoomifyTileGroup(d, ml, 0, 0)).toBe(Math.floor(below / 256));
  });

  it('IIIF builds a full-resolution region tile', () => {
    const d = dzi({ protocol: 'iiif', base: 'https://h/iiif/abc', width: 1000, height: 800, tileSize: 512, overlap: 0 });
    // col 1,row 0 at top level: x=512,y=0,w=min(512,1000-512)=488,h=min(512,800)=512
    expect(tileUrl(d, maxLevel(d), 1, 0)).toBe('https://h/iiif/abc/512,0,488,512/488,/0/default.jpg');
  });
});

describe('level selection', () => {
  it('thumbLevel is the largest single-tile level', () => {
    const d = dzi();
    const l = thumbLevel(d);
    expect(levelTiles(d, l)).toEqual({ cols: 1, rows: 1 });
    expect(levelTiles(d, l + 1).cols * levelTiles(d, l + 1).rows).toBeGreaterThan(1);
  });

  it('stitchLevel respects the canvas cap', () => {
    const d = dzi({ width: 40000, height: 30000 }); // top level too big for a cap
    const l = stitchLevel(d, 16384);
    const { w, h } = levelDimensions(d, l);
    expect(Math.max(w, h)).toBeLessThanOrEqual(16384);
    // and the next level up would exceed it
    const up = levelDimensions(d, l + 1);
    expect(Math.max(up.w, up.h)).toBeGreaterThan(16384);
  });

  it('stitchLevel returns the top level when it already fits', () => {
    const d = dzi(); // 4000 ≤ 16384
    expect(stitchLevel(d, 16384)).toBe(maxLevel(d));
  });
});

describe('osdTileSource', () => {
  it('exposes OSD pyramid fields and a tile-url getter', () => {
    const d = dzi();
    const ts = osdTileSource(d);
    expect(ts.width).toBe(4000);
    expect(ts.tileSize).toBe(254);
    expect(ts.tileOverlap).toBe(1);
    expect(ts.maxLevel).toBe(maxLevel(d));
    expect(ts.getTileUrl(12, 3, 2)).toBe('https://h/img_files/12/3_2.jpg');
  });

  it('can route tiles through the proxy', () => {
    const ts = osdTileSource(dzi(), true);
    expect(ts.getTileUrl(12, 0, 0)).toBe(
      `/api/tile?url=${encodeURIComponent('https://h/img_files/12/0_0.jpg')}`,
    );
  });
});
