/**
 * Tiny pure touch-gesture helpers for the <img> fallback viewer path (the OSD
 * load-failure case). The primary viewer uses OpenSeadragon's own gesture engine;
 * these only back the hand-rolled two-finger pinch so even the fallback gives a
 * native-feeling zoom instead of letting the browser zoom the whole page.
 */

export interface Point {
  x: number;
  y: number;
}

/** Euclidean distance between two pointer positions. */
export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Midpoint between two pointers (the pinch focal point). */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Zoom factor for a pinch: scales the zoom captured at gesture-start by the ratio
 * of current-to-start finger spread, clamped to [min, max]. A degenerate start
 * distance (single point) leaves the zoom untouched.
 */
export function pinchZoom(
  startDist: number,
  curDist: number,
  startZoom: number,
  min = 1,
  max = 6,
): number {
  if (startDist <= 0) return startZoom;
  return Math.min(max, Math.max(min, (startZoom * curDist) / startDist));
}
