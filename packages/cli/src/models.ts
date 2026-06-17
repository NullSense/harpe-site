/**
 * Shared data types — ported from harpe/models.py.
 * `spec` carries how to fetch an image: "url:<direct-image>" or "iiif:<manifest>".
 * `area` is the pixel area used as the resolution sort key (sources without
 * real dimensions use a large sentinel so they still rank as high-res).
 */

export interface Candidate {
  area: number;
  res: string;
  source: string;
  title: string;
  artist: string;
  date: string;
  spec: string;
  thumb: string;
  medium: string;
  desc: string;
  physdim: string;
}

/** Strip the "url:"/"iiif:" scheme prefix from spec to get the real source URL. */
export function sourceUrl(c: Candidate): string {
  for (const p of ['url:', 'iiif:']) {
    if (c.spec.startsWith(p)) return c.spec.slice(p.length);
  }
  return c.spec;
}
