import { describe, it, expect } from 'vitest';
import { dist, midpoint, pinchZoom } from './gesture';

describe('dist', () => {
  it('measures pointer spread', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(dist({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
  });
});

describe('midpoint', () => {
  it('is the pinch focal point', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 10 })).toEqual({ x: 2, y: 5 });
  });
});

describe('pinchZoom', () => {
  it('spreading fingers zooms in proportionally', () => {
    expect(pinchZoom(100, 200, 1)).toBe(2);
    expect(pinchZoom(100, 150, 2)).toBe(3);
  });
  it('pinching fingers zooms back out', () => {
    expect(pinchZoom(200, 100, 2)).toBe(1);
  });
  it('clamps to [min, max]', () => {
    expect(pinchZoom(100, 1000, 1)).toBe(6); // capped at max
    expect(pinchZoom(100, 1, 1)).toBe(1); // floored at min
    expect(pinchZoom(100, 1000, 1, 1, 4)).toBe(4); // custom max
  });
  it('a degenerate start distance leaves zoom unchanged', () => {
    expect(pinchZoom(0, 200, 2.5)).toBe(2.5);
  });
});
