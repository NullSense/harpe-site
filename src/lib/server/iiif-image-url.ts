/**
 * IIIF Image URL helpers.
 *
 * IIIF image URL anatomy:
 *   {base}/full/{size}/{rotation}/{quality}.{format}
 *
 * Named sizes used by this project:
 *   thumb   — !843,843  (best-fit, max 843 × 843)    — V&A, Wellcome, Harvard
 *   preview — !1600,1600 (best-fit, max 1600 × 1600)  — V&A, Wellcome, Harvard
 *   full    — full       (native resolution)
 *
 * AIC uses width-only sizing (843, not !843,843) — that adapter does NOT use
 * these helpers so its exact URLs remain unchanged.
 *
 * Usage:
 *   import { iiifImage, IIIF } from './iiif-image-url.js';
 *   iiifImage(base, '!843,843')           // explicit size string
 *   iiifImage(base, IIIF.THUMB)           // named constant
 */

/** Named size strings for the most common IIIF thumbnail sizes. */
export const IIIF = {
  /** Best-fit, max 843 × 843 px — used for thumbnails by V&A, Wellcome, Harvard. */
  THUMB: '!843,843',
  /** Best-fit, max 1600 × 1600 px — used for lightbox previews. */
  PREVIEW: '!1600,1600',
  /** Native resolution. */
  FULL: 'full',
} as const;

export type IiifSize = string; // any valid IIIF size string

/**
 * Build a standard IIIF image URL.
 *
 * @param base   The IIIF image base URL (without trailing slash), e.g.
 *               "https://iiif.wellcomecollection.org/image/V0017241".
 * @param size   A IIIF size string such as `IIIF.THUMB`, `IIIF.PREVIEW`, `IIIF.FULL`,
 *               or any raw value like `"!843,843"`.
 * @param rotation  Defaults to 0.
 * @param quality   Defaults to "default".
 * @param format    Defaults to "jpg".
 */
export function iiifImage(
  base: string,
  size: IiifSize,
  rotation = 0,
  quality = 'default',
  format = 'jpg',
): string {
  return `${base}/full/${size}/${rotation}/${quality}.${format}`;
}
