/**
 * Museum/gallery source adapters — each returns ArtItem[] using @harpe/core's
 * unified contract. This is the single home for all adapter implementations.
 *
 * Moved from src/lib/server/handlers/art.ts (monorepo-phase1 refactor).
 * All adapters preserve byte-identical output: same URLs, same field mapping,
 * same env gating, same behaviour. Low-risk GOD-FORMAT metadata improvements
 * are applied in-line (see audit comment on each adapter).
 */
import { fetch, Agent } from 'undici';
import { WBK, simplifyClaims } from 'wikibase-sdk';
import { normalize } from '@harpe/core';
import type { ArtItem, Download, ArtistEntity, SubjectEntity } from '@harpe/core';
import {
  str, num, fmtFromMime, fmtFromUrl, first, timedFetch, iiifImage, IIIF,
  LOSSLESS_FORMATS, mapPool, UA, deadline,
} from './helpers.js';
import { dumpHttpPolicy, isBrokenCircuitError } from './resilience.js';

// HTTP/2 dispatcher (lazy). NYPL's HTTP/1.1 path returns "HTTP Basic: Access
// denied" and ignores the Token auth scheme; over HTTP/2 (what curl uses) the
// Token is honoured. undici defaults to HTTP/1.1, so NYPL needs this explicitly.
let _h2: Agent | undefined;
export function h2Agent(): Agent {
  return (_h2 ??= new Agent({ allowH2: true }));
}

// ─── AIC (Art Institute of Chicago) ──────────────────────────────────────────
// GOD-FORMAT: added artwork_type_title → artworkType, classification_titles+subject_titles → tags,
// style_titles → style, inscriptions → inscriptions, main_reference_number → accessionNumber.

export async function fetchAic(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);

  try {
    const url =
      `https://api.artic.edu/api/v1/artworks/search` +
      `?q=${encodeURIComponent(q)}&fields=id,title,artist_title,image_id,is_public_domain,dimensions,date_display,medium_display,description,place_of_origin,credit_line,artwork_type_title,classification_titles,subject_titles,style_titles,inscriptions,main_reference_number&limit=25`;

    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      data?: Array<{
        id?: unknown;
        title?: unknown;
        artist_title?: unknown;
        image_id?: unknown;
        is_public_domain?: unknown;
        dimensions?: unknown;
        date_display?: unknown;
        medium_display?: unknown;
        description?: unknown;
        place_of_origin?: unknown;
        credit_line?: unknown;
        artwork_type_title?: unknown;
        classification_titles?: unknown;
        subject_titles?: unknown;
        style_titles?: unknown;
        inscriptions?: unknown;
        main_reference_number?: unknown;
      }>;
      config?: { iiif_url?: unknown };
    };

    const iiif = str(json.config?.iiif_url) || 'https://www.artic.edu/iiif/2';
    const items: ArtItem[] = [];

    for (const d of json.data ?? []) {
      const imageId = str(d.image_id);
      if (!imageId) continue;

      const base = `${iiif}/${imageId}`;
      const fullUrl = `${base}/full/full/0/default.jpg`;
      const artType = str(d.artwork_type_title) || undefined;

      // Combine classification_titles and subject_titles into tags.
      const tagArr: string[] = [];
      if (Array.isArray(d.classification_titles)) tagArr.push(...(d.classification_titles as unknown[]).map(str).filter(Boolean));
      if (Array.isArray(d.subject_titles)) tagArr.push(...(d.subject_titles as unknown[]).map(str).filter(Boolean));
      const tags = tagArr.length ? tagArr : undefined;

      // style_titles: first entry is the most specific movement/period.
      const styleTitles = Array.isArray(d.style_titles) ? (d.style_titles as unknown[]).map(str).filter(Boolean) : [];
      const style = styleTitles.length ? styleTitles[0] : undefined;

      const inscriptions = str(d.inscriptions) || undefined;
      const accessionNumber = str(d.main_reference_number) || undefined;

      items.push({
        id: `aic-${str(d.id)}`,
        title: str(d.title) || 'Untitled',
        artist: str(d.artist_title),
        dimensions: String(d.dimensions ?? ''),
        thumbUrl: `${base}/full/843,/0/default.jpg`,
        previewUrl: `${base}/full/1686,/0/default.jpg`,
        fullUrl,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: fullUrl, format: 'jpeg', lossless: false }],
        source: 'aic',
        isPublicDomain: Boolean(d.is_public_domain),
        date: str(d.date_display),
        medium: str(d.medium_display),
        culture: str(d.place_of_origin),
        creditLine: str(d.credit_line),
        description: str(d.description).replace(/<[^>]+>/g, ''), // strip HTML
        sourceUrl: `https://www.artic.edu/artworks/${str(d.id)}`,
        artworkType: artType,
        tags,
        style,
        inscriptions,
        accessionNumber,
      });
    }

    return items;
  } finally {
    dl.clear();
  }
}

// ─── Met (Metropolitan Museum of Art) ────────────────────────────────────────
// GOD-FORMAT: added objectName → artworkType; dimensions from measurements array.

export async function fetchMet(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);

  try {
    const searchUrl =
      `https://collectionapi.metmuseum.org/public/collection/v1/search` +
      `?q=${encodeURIComponent(q)}&hasImages=true`;

    const searchRes = await timedFetch(searchUrl, dl.signal);
    if (!searchRes.ok) throw new Error(`HTTP ${searchRes.status}`);

    const searchJson = await searchRes.json() as { objectIDs?: unknown[] };
    const ids = (searchJson.objectIDs ?? []).slice(0, 10).map(Number).filter(Boolean);
    if (ids.length === 0) return [];

    // Fetch each object concurrently, gracefully ignore failures
    const objectResults = await Promise.allSettled(
      ids.map((id) =>
        timedFetch(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
          dl.signal,
        ).then((r) => r.json()),
      ),
    );

    const items: ArtItem[] = [];
    for (const result of objectResults) {
      if (result.status !== 'fulfilled') continue;
      const d = result.value as {
        objectID?: unknown;
        title?: unknown;
        artistDisplayName?: unknown;
        culture?: unknown;
        dimensions?: unknown;
        primaryImage?: unknown;
        primaryImageSmall?: unknown;
        additionalImages?: unknown[];
        isPublicDomain?: unknown;
        objectDate?: unknown;
        medium?: unknown;
        creditLine?: unknown;
        objectURL?: unknown;
        objectName?: unknown;
        classification?: unknown;
        accessionNumber?: unknown;
        period?: unknown;
        dynasty?: unknown;
        tags?: Array<{ term?: unknown }>;
        measurements?: Array<{
          elementMeasurements?: { Height?: unknown; Width?: unknown };
          elementDescription?: unknown;
        }>;
      };

      const primaryImage = str(d.primaryImage);
      if (!primaryImage) continue;

      const thumbUrl = str(d.primaryImageSmall) || primaryImage;
      const artist = str(d.artistDisplayName) || str(d.culture);

      // Derive dimensions from the measurements array when available.
      let dimensions = String(d.dimensions ?? '');
      if (!dimensions && d.measurements?.length) {
        const m = d.measurements[0];
        const em = m?.elementMeasurements;
        if (em) {
          const h = num(em.Height);
          const w = num(em.Width);
          if (h && w) dimensions = `${h.toFixed(1)} × ${w.toFixed(1)} cm`;
          else if (h) dimensions = `H: ${h.toFixed(1)} cm`;
        }
      }

      const artType = str(d.objectName) || str(d.classification) || undefined;

      // additionalImages → extra download entries (JPEG, same as primary).
      const downloads: Download[] = [{ label: 'Full JPEG', url: primaryImage, format: 'jpeg', lossless: false }];
      if (Array.isArray(d.additionalImages)) {
        for (const imgUrl of d.additionalImages) {
          const u = str(imgUrl);
          if (u) downloads.push({ label: 'Additional JPEG', url: u, format: 'jpeg', lossless: false });
        }
      }

      // tags[].term → tags string array.
      const metTags = Array.isArray(d.tags)
        ? d.tags.map((t) => str(t?.term)).filter(Boolean)
        : undefined;
      const tags = metTags?.length ? metTags : undefined;

      // period and dynasty → style (period preferred).
      const style = str(d.period) || str(d.dynasty) || undefined;
      const accessionNumber = str(d.accessionNumber) || undefined;

      items.push({
        id: `met-${str(d.objectID)}`,
        title: str(d.title) || 'Untitled',
        artist,
        dimensions,
        thumbUrl,
        previewUrl: primaryImage,
        fullUrl: primaryImage,
        format: 'jpeg',
        lossless: false,
        downloads,
        source: 'met',
        date: str(d.objectDate),
        medium: str(d.medium),
        culture: str(d.culture),
        creditLine: str(d.creditLine),
        sourceUrl: str(d.objectURL),
        isPublicDomain: Boolean(d.isPublicDomain),
        artworkType: artType,
        tags,
        style,
        accessionNumber,
      });
    }

    return items;
  } finally {
    dl.clear();
  }
}

// ─── Cleveland Museum of Art ──────────────────────────────────────────────────
// GOD-FORMAT: added creditline → creditLine (was dropped before).

export async function fetchCleveland(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);

  try {
    // No cc0 filter — that excluded famous casts (e.g. Cleveland's The Thinker).
    // We keep has_image and badge rights per-item from share_license_status.
    const url =
      `https://openaccess-api.clevelandart.org/api/artworks/` +
      `?q=${encodeURIComponent(q)}&has_image=1&limit=25`;

    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      data?: Array<{
        id?: unknown;
        title?: unknown;
        creators?: Array<{ description?: unknown }>;
        share_license_status?: unknown;
        // dimensions is an OBJECT in Cleveland's API — deliberately typed as
        // unknown to force explicit handling below; never pass through raw.
        dimensions?: unknown;
        measurements?: unknown;
        description?: unknown;
        tombstone?: unknown;
        creation_date?: unknown;
        technique?: unknown;
        culture?: unknown[];
        url?: unknown;
        creditline?: unknown;
        accession_number?: unknown;
        type?: unknown;
        subjects?: { name?: unknown[] };
        images?: {
          web?: { url?: unknown };
          print?: { url?: unknown };
          full?: { url?: unknown };
        };
      }>;
    };

    const items: ArtItem[] = [];
    for (const d of json.data ?? []) {
      const images = (d.images ?? {}) as {
        web?: { url?: unknown; width?: unknown; height?: unknown };
        print?: { url?: unknown; width?: unknown; height?: unknown };
        full?: { url?: unknown; width?: unknown; height?: unknown };
      };
      // Cleveland exposes 3 variants: `web` JPEG (~250KB), `print` JPEG (~3MB),
      // and `full` TIFF (lossless original, tens of MB). Browsers can't render
      // TIFF, so it is NEVER used for display — only offered as a download.
      const webUrl = str(images.web?.url);
      const printUrl = str(images.print?.url);
      const tifUrl = str(images.full?.url);
      const thumbUrl = webUrl || printUrl;
      const previewUrl = printUrl || webUrl; // JPEG — renderable in the lightbox
      if (!thumbUrl) continue;

      const downloads: Download[] = [];
      if (printUrl) downloads.push({ label: 'High-res JPEG', url: printUrl, format: 'jpeg', lossless: false });
      else if (webUrl) downloads.push({ label: 'JPEG', url: webUrl, format: 'jpeg', lossless: false });
      if (tifUrl) downloads.push({ label: 'Original TIFF', url: tifUrl, format: 'tiff', lossless: true });
      const fullUrl = downloads[0]?.url ?? thumbUrl;

      const artist =
        (d.creators?.[0] !== undefined ? str(d.creators[0].description) : '') || '';

      // Cleveland's `dimensions` field is an OBJECT — do NOT use it.
      // Use `measurements` (a string field) when available; otherwise empty string.
      const dimensions = typeof d.measurements === 'string' ? d.measurements : '';
      // Pixel size of the largest available variant (TIFF original → print → web).
      const px = images.full ?? images.print ?? images.web ?? {};

      const creditLine = str(d.creditline) || undefined;
      const artType = str(d.type) || undefined;
      const accessionNumber = str(d.accession_number) || undefined;

      // subjects.name[] → tags (Cleveland groups subject terms under this path).
      const subjectNames = Array.isArray(d.subjects?.name)
        ? (d.subjects.name as unknown[]).map(str).filter(Boolean)
        : [];
      const tags = subjectNames.length ? subjectNames : undefined;

      items.push({
        id: `cleveland-${str(d.id)}`,
        title: str(d.title) || 'Untitled',
        artist,
        dimensions,
        thumbUrl,
        previewUrl,
        fullUrl,
        width: Number(px.width) || undefined,
        height: Number(px.height) || undefined,
        format: 'jpeg',
        lossless: downloads.some((dl) => dl.lossless),
        downloads,
        source: 'cleveland',
        isPublicDomain: str(d.share_license_status).toUpperCase() === 'CC0',
        date: str(d.creation_date),
        medium: str(d.technique),
        culture: Array.isArray(d.culture) ? d.culture.map(str).filter(Boolean).join(', ') : '',
        description: str(d.description) || str(d.tombstone),
        sourceUrl: str(d.url),
        creditLine,
        artworkType: artType,
        accessionNumber,
        tags,
      });
    }

    return items;
  } finally {
    dl.clear();
  }
}

// ─── Wikimedia Commons (huge coverage — the real recall fix) ──────────────────
// GOD-FORMAT: added extmetadata: Artist → artist, DateTimeOriginal → date,
// ImageDescription → description, Credit → creditLine, LicenseUrl → licenseUrl,
// and constructed sourceUrl from page title.

export async function fetchCommons(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);

  try {
    const url =
      `https://commons.wikimedia.org/w/api.php?action=query&format=json` +
      `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=25` +
      `&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiurlwidth=1024`;

    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      query?: {
        pages?: Record<string, {
          title?: unknown;
          imageinfo?: Array<{
            url?: unknown; thumburl?: unknown;
            width?: unknown; height?: unknown; mime?: unknown;
            extmetadata?: {
              LicenseShortName?: { value?: unknown };
              License?: { value?: unknown };
              UsageTerms?: { value?: unknown };
              Artist?: { value?: unknown };
              DateTimeOriginal?: { value?: unknown };
              DateTime?: { value?: unknown };
              ImageDescription?: { value?: unknown };
              Credit?: { value?: unknown };
              LicenseUrl?: { value?: unknown };
            };
          }>;
        }>;
      };
    };

    const items: ArtItem[] = [];
    // Keys of `pages` are numeric pageids — use them for a stable, unique id.
    // The filename (title) is NOT unique: File:Foo.jpg and File:Foo.png would
    // collide on `commons-Foo` and the dedup Map would silently drop one.
    for (const [pageId, p] of Object.entries(json.query?.pages ?? {})) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const mime = str(ii.mime);
      if (!/^image\/(jpeg|png|tiff|webp)/.test(mime)) continue;
      const full = str(ii.url);
      if (!full) continue;
      const w = Number(ii.width) || 0;
      const h = Number(ii.height) || 0;
      const rawTitle = str(p.title);
      const title = rawTitle.replace(/^File:/, '').replace(/\.[A-Za-z0-9]+$/, '');
      // The rendered thumbnail (`thumburl`) is always a browser-renderable JPEG/PNG
      // even when the original is a TIFF, so it's safe for both the card and lightbox.
      const rendered = str(ii.thumburl) || full;
      const format = fmtFromMime(mime);
      const lossless = LOSSLESS_FORMATS.has(format);
      // Commons hosts CC0 / PD as well as CC-BY / CC-BY-SA / GFDL works.
      // Use extmetadata to determine the actual license; only mark public-domain
      // for CC0 and unambiguously PD-marked items. Missing metadata → false.
      const licShort = str(ii.extmetadata?.LicenseShortName?.value).toLowerCase();
      const licKey = str(ii.extmetadata?.License?.value).toLowerCase();
      const usage = str(ii.extmetadata?.UsageTerms?.value).toLowerCase();
      const isPublicDomain =
        licShort.includes('cc0') || licShort.includes('public domain') ||
        licKey.includes('cc0') || licKey.includes('publicdomain') ||
        usage.includes('public domain') || usage.includes('no known copyright');

      // GOD-FORMAT: map extmetadata fields that were previously ignored.
      const rawArtist = str(ii.extmetadata?.Artist?.value).replace(/<[^>]+>/g, '').trim();
      // Commons date fields embed a hidden <div style=display:none>date QS:P571,…
      // </div> machine-data blob. Strip tags, then cleanDate() cuts the QS: tail so
      // it never fuses onto the readable date ("circa 1665date QS:…" → "circa 1665").
      const rawDate = cleanDate(
        (str(ii.extmetadata?.DateTimeOriginal?.value) || str(ii.extmetadata?.DateTime?.value))
          .replace(/<[^>]+>/g, ' ').trim(),
      );
      const rawDesc = str(ii.extmetadata?.ImageDescription?.value).replace(/<[^>]+>/g, '').trim();
      const rawCredit = str(ii.extmetadata?.Credit?.value).replace(/<[^>]+>/g, '').trim();
      const rawLicUrl = str(ii.extmetadata?.LicenseUrl?.value).trim();
      // Canonical source URL: the file description page on Commons.
      const pageTitle = str(p.title);
      const sourceUrl = pageTitle
        ? `https://commons.wikimedia.org/wiki/${pageTitle.replace(/ /g, '_')}`
        : undefined;

      items.push({
        id: `commons-${pageId}`,
        title: title || 'Untitled',
        artist: rawArtist || '',
        dimensions: w && h ? `${w} × ${h} px` : '',
        thumbUrl: rendered,
        previewUrl: rendered,
        fullUrl: full,
        width: w || undefined,
        height: h || undefined,
        format,
        lossless,
        downloads: [{ label: `Original ${format.toUpperCase()}`, url: full, format, lossless }],
        source: 'commons',
        isPublicDomain,
        date: rawDate,
        description: rawDesc || undefined,
        creditLine: rawCredit || undefined,
        licenseUrl: rawLicUrl || undefined,
        sourceUrl,
      });
    }

    await enrichCommonsWikidataIds(items, dl.signal);
    return items;
  } finally {
    dl.clear();
  }
}

// ─── Commons → Wikidata QID enrichment (the cross-language unifier) ────────────
// A Commons file's Structured Data carries P6243 "digital representation of" → the
// artwork's Wikidata QID (used for 2-D artwork scans/photos under PD-art). That
// QID is language-independent, so the Polish and English scans of one painting —
// and the matching Wikidata item — all share it, letting dedupe() fold them into
// one card. Best-effort: ANY failure leaves items unchanged (search must never
// break because Structured Data was slow/unavailable). `wikibase-sdk` builds the
// wbgetentities URLs (incl. the >50-id batching) and simplifies the claims, so we
// don't hand-parse Wikibase's snak format; an in-instance cache spares repeats.
const _wbkCommons = WBK({ instance: 'https://commons.wikimedia.org' }); // Commons MediaInfo Wikibase
const _sdcCache = new Map<string, string | null>(); // pageid → QID | null (resolved miss)

export async function enrichCommonsWikidataIds(items: ArtItem[], signal: AbortSignal): Promise<void> {
  const need = new Map<string, ArtItem>(); // uncached pageid → item
  for (const it of items) {
    const m = /^commons-(\d+)$/.exec(it.id);
    if (!m) continue;
    const cached = _sdcCache.get(m[1]);
    if (cached !== undefined) { if (cached) it.wikidataId = cached; continue; }
    need.set(m[1], it);
  }
  if (need.size === 0) return;
  // MediaInfo entity id is "M" + the file's pageid.
  const mids = [...need.keys()].map((p) => `M${p}`) as `M${number}`[];
  try {
    for (const url of _wbkCommons.getManyEntities({ ids: mids, props: ['claims'] })) {
      const res = await timedFetch(url, signal);
      if (!res.ok) return; // give up quietly — items keep flowing without a QID
      const json = await res.json() as { entities?: Record<string, { statements?: unknown; claims?: unknown }> };
      for (const [mid, ent] of Object.entries(json.entities ?? {})) {
        const pid = mid.slice(1); // strip the leading "M"
        // MediaInfo exposes statements under `statements` (older API: `claims`).
        const claims = (ent.statements ?? ent.claims) as Parameters<typeof simplifyClaims>[0];
        // P6243 "digital representation of" → the depicted artwork's QID.
        const qid = claims ? (simplifyClaims(claims).P6243?.[0] as string | undefined) : undefined;
        const valid = typeof qid === 'string' && /^Q\d+$/.test(qid) ? qid : null;
        _sdcCache.set(pid, valid);
        if (valid) { const it = need.get(pid); if (it) it.wikidataId = valid; }
      }
    }
  } catch { /* best-effort: leave items unenriched */ }
}

// ─── WikiArt (paintings-focused; keyless v2 API) ──────────────────────────────
// GOD-FORMAT: style, medium, artworkType, tags, accessionNumber require the per-painting
// detail endpoint (GET /en/api/2/Painting?paintingUrl=…) — deferred for latency.
// TODO: add per-painting detail fetch for full WikiArt enrichment.

export async function fetchWikiArt(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);

  try {
    const url = `https://www.wikiart.org/en/api/2/PaintingSearch?term=${encodeURIComponent(q)}`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      data?: Array<{
        id?: unknown; title?: unknown; artistName?: unknown;
        completitionYear?: unknown; image?: unknown;
        width?: unknown; height?: unknown;
      }>;
    };

    const items: ArtItem[] = [];
    for (const d of json.data ?? []) {
      const image = str(d.image);
      if (!image) continue;
      const w = Number(d.width) || 0;
      const h = Number(d.height) || 0;
      const original = image.replace(/!.*$/, ''); // strip variant suffix → original
      const format = fmtFromUrl(original);
      items.push({
        id: `wikiart-${str(d.id)}`,
        title: str(d.title) || 'Untitled', // date is its own field — don't append it
        artist: str(d.artistName),
        dimensions: w && h ? `${w} × ${h} px` : '',
        thumbUrl: image, // the "!Large.jpg" variant
        previewUrl: image,
        fullUrl: original,
        width: w || undefined,
        height: h || undefined,
        format,
        lossless: LOSSLESS_FORMATS.has(format),
        downloads: [{ label: `Original ${format.toUpperCase()}`, url: original, format, lossless: LOSSLESS_FORMATS.has(format) }],
        source: 'wikiart',
        isPublicDomain: false, // WikiArt is mixed-rights; badge a rights caution
        date: str(d.completitionYear),
      });
    }

    return items;
  } finally {
    dl.clear();
  }
}

// ─── Victoria & Albert Museum (UK; keyless v2 API, IIIF images) ───────────────
// GOD-FORMAT: objectType → artworkType already mapped. accessionNumber, tags,
// style, inscriptions, medium, creditLine, description require the per-object
// detail endpoint (GET /v2/object/<systemNumber>) which adds a network request
// per result — deferred for latency.
// TODO: add per-object detail fetch for full V&A enrichment.

export async function fetchVam(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);

  try {
    const url =
      `https://api.vam.ac.uk/v2/objects/search` +
      `?q=${encodeURIComponent(q)}&images_exist=1&page_size=25`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      records?: Array<{
        systemNumber?: unknown;
        _primaryTitle?: unknown;
        objectType?: unknown;
        _primaryMaker?: { name?: unknown };
        _primaryDate?: unknown;
        _images?: { _iiif_image_base_url?: unknown };
      }>;
    };

    const items: ArtItem[] = [];
    for (const r of json.records ?? []) {
      const base = str(r._images?._iiif_image_base_url).replace(/\/$/, '');
      if (!base) continue;
      const date = str(r._primaryDate);
      const full = iiifImage(base, IIIF.FULL);
      const artType = str(r.objectType) || undefined;
      items.push({
        id: `vam-${str(r.systemNumber)}`,
        // Title only — the date lives in its own field; appending it duplicated the
        // date in the UI AND broke dedupe's workKey ("Portrait (1750)" ≠ "Portrait").
        title: str(r._primaryTitle) || str(r.objectType) || 'Untitled',
        artist: str(r._primaryMaker?.name),
        dimensions: '',
        thumbUrl: iiifImage(base, IIIF.THUMB),
        previewUrl: iiifImage(base, IIIF.PREVIEW),
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'vam',
        isPublicDomain: false, // V&A images are mixed-rights — badge a caution
        date,
        // objectType ("Painting", "Ceramics") is an artwork TYPE, not a physical
        // medium — it's carried by artworkType below; don't mislabel it as medium.
        sourceUrl: `https://collections.vam.ac.uk/item/${str(r.systemNumber)}`,
        artworkType: artType,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── Wellcome Collection (UK; keyless catalogue API, IIIF images) ─────────────
// GOD-FORMAT: added contributor → artist (first person named), production date → date,
// physicalDescription → medium; inspect actual license from work-level licenses
// instead of hardcoding isPublicDomain=true.

export async function fetchWellcome(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);

  try {
    const url =
      `https://api.wellcomecollection.org/catalogue/v2/works` +
      `?query=${encodeURIComponent(q)}&pageSize=25&include=items,contributors,production,notes`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      results?: Array<{
        id?: unknown;
        title?: unknown;
        thumbnail?: { url?: unknown };
        contributors?: Array<{
          agent?: { label?: unknown };
          roles?: Array<{ label?: unknown }>;
        }>;
        production?: Array<{
          dates?: Array<{ label?: unknown }>;
        }>;
        physicalDescription?: unknown;
        notes?: Array<{ noteType?: { id?: unknown }; contents?: unknown[] }>;
        // License lives per item-location, not at work level.
        items?: Array<{ locations?: Array<{ license?: { id?: unknown; url?: unknown; label?: unknown } }> }>;
      }>;
    };

    const items: ArtItem[] = [];
    for (const w of json.results ?? []) {
      // thumbnail: .../thumbs/<imageId>/full/!200,200/0/default.jpg — derive the
      // full IIIF image from the same imageId via the /image/ service.
      const thumb = str(w.thumbnail?.url);
      const m = thumb.match(/\/thumbs\/([^/]+)\/full\//);
      if (!m) continue;
      const base = `https://iiif.wellcomecollection.org/image/${m[1]}`;
      const full = iiifImage(base, IIIF.FULL);

      // GOD-FORMAT: map contributor, production date, physicalDescription, notes, license.
      const contrib = w.contributors?.find((c) => {
        const roles = c.roles ?? [];
        return roles.length === 0 ||
          roles.some((r) => {
            const lbl = str(r.label).toLowerCase();
            return lbl.includes('artist') || lbl.includes('author') || lbl.includes('creator');
          });
      }) ?? w.contributors?.[0];
      const artist = contrib ? str(contrib.agent?.label) : '';

      const prodDate = w.production?.[0]?.dates?.[0];
      const date = prodDate ? str(prodDate.label) : undefined;

      const medium = str(w.physicalDescription) || undefined;

      // License is per item-location; take the first one present. Default open.
      const licInfo = (w.items ?? [])
        .flatMap((it) => it.locations ?? [])
        .map((loc) => loc.license)
        .find((l) => l && (l.id || l.url));
      const licUrl = licInfo ? str(licInfo.url) || undefined : undefined;
      const licId = licInfo ? str(licInfo.id).toLowerCase() : '';
      const isPublicDomain = licId
        ? (licId.includes('cc-by') || licId.includes('cc0') || licId.includes('pdm'))
        : true; // Wellcome Collection is open access (CC0/CC-BY/PD) — default true

      const noteItem = w.notes?.find((n) => str(n.noteType?.id) === 'general-note');
      const description = noteItem?.contents?.length
        ? str(noteItem.contents[0])
        : undefined;

      items.push({
        id: `wellcome-${str(w.id)}`,
        title: str(w.title) || 'Untitled',
        artist: artist || '',
        dimensions: '',
        thumbUrl: iiifImage(base, IIIF.THUMB),
        previewUrl: iiifImage(base, IIIF.PREVIEW),
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'wellcome',
        isPublicDomain,
        sourceUrl: `https://wellcomecollection.org/works/${str(w.id)}`,
        date,
        medium,
        licenseUrl: licUrl,
        description,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── SMK — Statens Museum for Kunst (Denmark; keyless, IIIF) ──────────────────
// GOD-FORMAT: added production_date → date, technique → medium, content_description → description,
// dimensions[] → dimensions string, materials → appended to medium, inscription → inscriptions,
// object_number → accessionNumber.

export async function fetchSmk(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);
  try {
    const url =
      `https://api.smk.dk/api/v1/art/search?keys=${encodeURIComponent(q)}` +
      `&filters=%5Bhas_image%3Atrue%5D&offset=0&rows=25`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      items?: Array<{
        object_number?: unknown;
        titles?: Array<{ title?: unknown; language?: unknown }>;
        artist?: unknown;
        image_thumbnail?: unknown;
        image_iiif_id?: unknown;
        image_width?: unknown;
        image_height?: unknown;
        public_domain?: unknown;
        production_date?: Array<{ period?: unknown; start?: unknown; end?: unknown }>;
        technique?: unknown;
        materials?: unknown[];
        dimensions?: Array<{ type?: unknown; value?: unknown; unit?: unknown }>;
        content_description?: unknown;
        inscription?: unknown;
        objectname?: unknown;
      }>;
    };
    const items: ArtItem[] = [];
    for (const it of json.items ?? []) {
      const iiif = str(it.image_iiif_id);
      const thumb0 = str(it.image_thumbnail);
      if (!iiif && !thumb0) continue;
      const titles = it.titles ?? [];
      const en = titles.find((t) => str(t.language) === 'engelsk');
      const title = str(en?.title) || str(titles[0]?.title) || 'Untitled';
      const full = iiif ? `${iiif}/full/full/0/default.jpg` : thumb0;

      // GOD-FORMAT: map production_date, technique, content_description.
      const prodDate = it.production_date?.[0];
      let date: string | undefined;
      if (prodDate) {
        date = str(prodDate.period) || (prodDate.start
          ? `${str(prodDate.start)}${prodDate.end ? `–${str(prodDate.end)}` : ''}`
          : undefined);
      }
      // Combine technique + materials into medium.
      const tech = str(it.technique);
      const mats = Array.isArray(it.materials)
        ? (it.materials as unknown[]).map(str).filter(Boolean).join(', ')
        : '';
      const medium = [tech, mats].filter(Boolean).join('; ') || undefined;

      const description = str(it.content_description) || undefined;
      const artType = str(it.objectname) || undefined;

      // Build dimensions string from the dimensions[] array.
      let dimensions = '';
      if (Array.isArray(it.dimensions) && it.dimensions.length) {
        dimensions = it.dimensions
          .map((dim) => {
            const type = str(dim.type);
            const val = str(dim.value);
            const unit = str(dim.unit);
            return type && val ? `${type}: ${val}${unit ? ' ' + unit : ''}` : val;
          })
          .filter(Boolean)
          .join(', ');
      }

      const inscriptions = str(it.inscription) || undefined;
      const accessionNumber = str(it.object_number) || undefined;

      items.push({
        id: `smk-${str(it.object_number)}`,
        title,
        artist: first(it.artist),
        dimensions,
        thumbUrl: thumb0 || `${iiif}/full/!843,/0/default.jpg`,
        previewUrl: iiif ? `${iiif}/full/!1600,/0/default.jpg` : thumb0,
        fullUrl: full,
        width: Number(it.image_width) || undefined,
        height: Number(it.image_height) || undefined,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'smk',
        isPublicDomain: Boolean(it.public_domain),
        sourceUrl: `https://open.smk.dk/en/artwork/image/${str(it.object_number)}`,
        date,
        medium,
        description,
        artworkType: artType,
        inscriptions,
        accessionNumber,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── Nasjonalmuseet (Norway; keyless, IIIF) ───────────────────────────────────
// GOD-FORMAT: added sourceUrl (from inventoryNumber), culture (from classifications/production).

export async function fetchNasjonalmuseet(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);
  try {
    const url = `https://api.nasjonalmuseet.no/api/v1/objects/text-search?q=${encodeURIComponent(q)}`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      data?: Array<{
        uuid?: unknown;
        nmId?: unknown;
        inventoryNumber?: unknown;
        mainTitle?: unknown;
        labelDate?: unknown;
        objectName?: unknown;
        materialTechniqueDescription?: unknown;
        publishableDimensions?: unknown;
        creditLine?: unknown;
        production?: Array<{ person?: { name?: unknown }; role?: unknown; place?: unknown }>;
        classifications?: Array<{ term?: unknown; type?: unknown }>;
        multimedia?: Array<{ imageUrl?: unknown; iiifUrl?: unknown; thumbnail?: unknown }>;
      }>;
    };
    const items: ArtItem[] = [];
    for (const it of (json.data ?? []).slice(0, 15)) {
      const mm = it.multimedia ?? [];
      const primary = mm.find((m) => str(m.iiifUrl)) ?? mm[0];
      if (!primary) continue;
      const iiif = str(primary.iiifUrl); // ends with /full/full/0/default.jpg
      const img = str(primary.imageUrl);
      let thumb = img, preview = img, full = img;
      if (iiif) {
        thumb = iiif.replace('/full/full/', '/full/!843,/');
        preview = iiif.replace('/full/full/', '/full/!1600,/');
        full = iiif;
      }
      if (!thumb) continue;
      // Stable, UNIQUE id: the API dropped `id`; use uuid → nmId → inventoryNumber.
      // Without one we'd emit duplicate `nasjonalmuseet-` ids → key collisions and
      // a detail view that opens the wrong/no item. Skip if none exists.
      const stableId = str(it.uuid) || str(it.nmId) || str(it.inventoryNumber);
      if (!stableId) continue;
      const artist = it.production?.find((p) => p.person && str(p.person.name))?.person;
      const title = str(it.mainTitle) || 'Untitled';
      const artistName = artist ? str(artist.name) : '';

      // GOD-FORMAT: sourceUrl from inventoryNumber, culture from classifications or production.
      const invNum = str(it.inventoryNumber);
      const sourceUrl = invNum
        ? `https://www.nasjonalmuseet.no/en/collection/object/${stableId}`
        : undefined;
      const placeEntry = it.production?.find((p) => p.place);
      const classEntry = it.classifications?.find(
        (c) => str(c.type).toLowerCase() === 'place' || str(c.type).toLowerCase() === 'culture',
      );
      const culture = str(classEntry?.term) ||
        (placeEntry ? str(placeEntry.place) : undefined) ||
        undefined;

      items.push({
        id: `nasjonalmuseet-${stableId}`,
        title,
        artist: artistName,
        dimensions: str(it.publishableDimensions),
        thumbUrl: thumb,
        previewUrl: preview,
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'nasjonalmuseet',
        isPublicDomain: false, // mixed rights — badge a caution
        date: str(it.labelDate) || undefined,
        medium: str(it.materialTechniqueDescription) || str(it.objectName) || undefined,
        creditLine: str(it.creditLine) || undefined,
        sourceUrl,
        culture,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── DigitalNZ (New Zealand aggregator; keyless) ──────────────────────────────
// GOD-FORMAT: added rights → licenseUrl, subject → tags.

export async function fetchDigitalNZ(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);
  try {
    const url =
      `https://api.digitalnz.org/v3/records.json?text=${encodeURIComponent(q)}` +
      `&i%5Bcategory%5D=Images&per_page=25`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      search?: { results?: Array<{
        id?: unknown; title?: unknown; creator?: unknown;
        thumbnail_url?: unknown; large_thumbnail_url?: unknown;
        description?: unknown; date?: unknown; landing_url?: unknown; display_content_partner?: unknown;
        rights?: unknown; subject?: unknown;
      }> };
    };
    const items: ArtItem[] = [];
    for (const r of json.search?.results ?? []) {
      const thumb = str(r.thumbnail_url);
      if (!thumb) continue;
      const title = str(r.title) || 'Untitled';
      const artist = first(r.creator);
      const large = str(r.large_thumbnail_url) || thumb;

      // rights → licenseUrl (may be a CC URL or a plain rights statement).
      const rights = first(r.rights);
      const licenseUrl = (rights && /^https?:\/\//i.test(rights)) ? rights : undefined;

      // subject → tags (may be a string or array).
      const subjectRaw = r.subject;
      const subjectArr = Array.isArray(subjectRaw)
        ? (subjectRaw as unknown[]).map(str).filter(Boolean)
        : str(subjectRaw) ? [str(subjectRaw)] : [];
      const tags = subjectArr.length ? subjectArr : undefined;

      items.push({
        id: `digitalnz-${str(r.id)}`,
        title,
        artist,
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: large,
        fullUrl: large,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Image', url: large, format: 'jpeg', lossless: false }],
        source: 'digitalnz',
        isPublicDomain: false, // mixed rights — badge a caution
        date: first(r.date).slice(0, 10), // trim ISO timestamps to YYYY-MM-DD
        description: first(r.description),
        culture: str(r.display_content_partner),
        sourceUrl: first(r.landing_url),
        licenseUrl,
        tags,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── Wikidata (keyless; covers museums with no API of their own) ──────────────
// Full-text entity search (MWAPI) → keep items that have a P18 image, with the
// creator (P170) and holding collection (P195). This is how works from the
// Louvre, Prado, Rijksmuseum, Uffizi, etc. (no usable API) reach the search:
// their pieces are modelled in Wikidata with Commons images.
// GOD-FORMAT: added OPTIONAL P135 (movement → style), P2048/P2049 (height/width cm → dimensions),
// P180/P921 (depicts/main subject → tags), P276 (location → culture supplement).

export async function fetchWikidata(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);
  try {
    const safe = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]/g, ' ');
    const sparql =
      `SELECT ?item ?itemLabel ?itemDescription ?image ?creatorLabel ?collectionLabel ?inception ?materialLabel ?genreLabel ?movementLabel ?height ?width ?depictsLabel ?locationLabel WHERE {` +
      ` SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org";` +
      ` wikibase:api "EntitySearch"; mwapi:search "${safe}"; mwapi:language "en".` +
      ` ?item wikibase:apiOutputItem mwapi:item. }` +
      ` ?item wdt:P18 ?image.` +
      ` OPTIONAL { ?item wdt:P170 ?creator. }` +
      ` OPTIONAL { ?item wdt:P195 ?collection. }` +
      ` OPTIONAL { ?item wdt:P571 ?inception. }` +
      ` OPTIONAL { ?item wdt:P186 ?material. }` +
      ` OPTIONAL { ?item wdt:P136 ?genre. }` +
      ` OPTIONAL { ?item wdt:P135 ?movement. }` +
      ` OPTIONAL { ?item wdt:P2048 ?height. }` +
      ` OPTIONAL { ?item wdt:P2049 ?width. }` +
      ` OPTIONAL { ?item wdt:P180 ?depicts. }` +
      ` OPTIONAL { ?item wdt:P276 ?location. }` +
      ` SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 25`;
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      results?: { bindings?: Array<Record<string, { value?: unknown }>> };
    };

    const items: ArtItem[] = [];
    const seenItems = new Set<string>();
    for (const b of json.results?.bindings ?? []) {
      const itemUri = str(b.item?.value);
      if (!itemUri || seenItems.has(itemUri)) continue; // dedupe item × creator × collection rows
      const rawImage = str(b.image?.value);
      if (!rawImage) continue;
      seenItems.add(itemUri);
      // Commons Special:FilePath URL — upgrade to https; size via ?width=
      const fileBase = rawImage.replace(/^http:/, 'https:');
      const collection = str(b.collectionLabel?.value);
      const sep = fileBase.includes('?') ? '&' : '?';
      const genre = str(b.genreLabel?.value);

      // P135 movement → style.
      const style = str(b.movementLabel?.value) || undefined;

      // P2048/P2049 height/width in cm → dimensions string if both present.
      const hCm = b.height ? Number(str(b.height.value)) : 0;
      const wCm = b.width ? Number(str(b.width.value)) : 0;
      const dimensions = hCm && wCm ? `${hCm.toFixed(1)} × ${wCm.toFixed(1)} cm` : '';

      // P180 depicts → tags.
      const depictsLabel = str(b.depictsLabel?.value);
      const tags = depictsLabel ? [depictsLabel] : undefined;

      // P276 location supplements culture.
      const locationLabel = str(b.locationLabel?.value);
      const culture = [genre, locationLabel].filter(Boolean).join('; ') || genre || undefined;

      items.push({
        id: `wikidata-${itemUri.split('/').pop()}`,
        title: str(b.itemLabel?.value) || 'Untitled',
        artist: str(b.creatorLabel?.value),
        dimensions,
        thumbUrl: `${fileBase}${sep}width=843`,
        previewUrl: `${fileBase}${sep}width=1600`,
        fullUrl: fileBase,
        format: fmtFromUrl(fileBase),
        lossless: false,
        downloads: [{ label: 'Full image', url: fileBase, format: fmtFromUrl(fileBase), lossless: false }],
        source: 'wikidata',
        isPublicDomain: true, // P18 images live on Commons (freely licensed)
        // Year only — but BCE ISO dates start with '-' ("-0620-…"), so slice(0,4)
        // would truncate to "-062"; match an optional sign + 1-4 digits instead.
        date: str(b.inception?.value).replace(/^(-?\d{1,4}).*/, '$1'),
        medium: str(b.materialLabel?.value), // P186 material/technique
        culture,                              // P136 genre + P276 location
        creditLine: collection,               // P195 holding collection
        description: str(b.itemDescription?.value),
        sourceUrl: itemUri,
        style,
        tags,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── Keyed sources (dormant until their env key is set) ───────────────────────
// These read a free API key from a server-only env var. The key NEVER reaches
// the browser (Vite only bundles VITE_-prefixed vars; these run in the
// serverless function). Each fetcher is only added to the fan-out when its key
// is present, so the site works fully without any of them.

const EUROPEANA_COUNTRY_FOCUS = [
  'Austria',
  'Belgium',
  'Bulgaria',
  'Croatia',
  'Cyprus',
  'Czech Republic',
  'Denmark',
  'Estonia',
  'Finland',
  'France',
  'Germany',
  'Greece',
  'Hungary',
  'Ireland',
  'Italy',
  'Latvia',
  'Lithuania',
  'Luxembourg',
  'Malta',
  'Netherlands',
  'Norway',
  'Poland',
  'Portugal',
  'Romania',
  'Slovakia',
  'Slovenia',
  'Spain',
  'Sweden',
  'Ukraine',
  'United Kingdom',
] as const;

function europeanaSearchUrl(key: string, q: string, country?: string): string {
  const params = new URLSearchParams({
    wskey: key,
    query: q,
    reusability: 'open',
    media: 'true',
    thumbnail: 'true',
    rows: country ? '8' : '15',
  });
  params.append('qf', 'TYPE:IMAGE');
  if (country) params.append('qf', `COUNTRY:"${country}"`);
  return `https://api.europeana.eu/record/v2/search.json?${params.toString()}`;
}

// GOD-FORMAT: added edmRights → licenseUrl, dcSubject → tags, dcType → artworkType,
// dctermsExtent → dimensions (when empty).
async function fetchEuropeanaBatch(key: string, q: string, signal: AbortSignal, country?: string): Promise<ArtItem[]> {
  const res = await timedFetch(europeanaSearchUrl(key, q, country), signal);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as {
    items?: Array<{
      title?: unknown; dcCreator?: unknown; edmPreview?: unknown;
      edmIsShownBy?: unknown; isShownBy?: unknown; guid?: unknown; id?: unknown;
      dcDescription?: unknown; year?: unknown; dataProvider?: unknown;
      edmIsShownAt?: unknown; country?: unknown;
      edmRights?: unknown; dcSubject?: unknown; dcType?: unknown; dctermsExtent?: unknown;
    }>;
  };
  const items: ArtItem[] = [];
  for (const it of json.items ?? []) {
    const thumb = first(it.edmPreview);
    const full = first(it.edmIsShownBy) || first(it.isShownBy) || thumb;
    if (!thumb) continue;
    const fmt = fmtFromUrl(full || thumb);
    const provider = first(it.dataProvider);
    const itemCountry = country || first(it.country);

    // edmRights → licenseUrl (Europeana uses an array).
    const rights = first(it.edmRights);
    const licenseUrl = (rights && /^https?:\/\//i.test(rights)) ? rights : undefined;

    // dcSubject → tags.
    const subjectRaw = it.dcSubject;
    const subjectArr = Array.isArray(subjectRaw)
      ? (subjectRaw as unknown[]).map(str).filter(Boolean)
      : str(subjectRaw) ? [str(subjectRaw)] : [];
    const tags = subjectArr.length ? subjectArr : undefined;

    // dcType → artworkType.
    const artworkType = first(it.dcType) || undefined;

    // dctermsExtent → dimensions (if available).
    const dimensions = first(it.dctermsExtent) || '';

    items.push({
      id: `europeana-${str(it.id) || str(it.guid)}`,
      title: first(it.title) || 'Untitled',
      artist: first(it.dcCreator),
      dimensions,
      thumbUrl: thumb,
      previewUrl: full || thumb,
      fullUrl: full || thumb,
      format: fmt,
      lossless: LOSSLESS_FORMATS.has(fmt),
      downloads: [{ label: 'Full image', url: full || thumb, format: fmt, lossless: LOSSLESS_FORMATS.has(fmt) }],
      source: 'europeana',
      isPublicDomain: true, // reusability=open filter
      date: first(it.year),
      culture: [provider, itemCountry].filter(Boolean).join(' · '),
      description: first(it.dcDescription),
      sourceUrl: first(it.edmIsShownAt) || str(it.guid),
      provider,
      licenseUrl,
      tags,
      artworkType,
    });
  }
  return items;
}

// Europeana — aggregates 3,000+ European institutions. Free key: EUROPEANA_API_KEY
//
// Sparse-gated fan-out (best for search quality): the base query is already
// pan-European and the final results are RRF-reranked + capped, so for a
// well-covered query the per-country queries only return lower-relevance items
// that get discarded — pure latency/quota cost, no quality gain. We therefore
// run the base query FIRST and only fan out to the focus countries when the base
// is sparse (< EUROPEANA_SPARSE_MIN results), where the extra country queries
// genuinely lift recall for works held in smaller national collections. The
// fan-out runs through a bounded pool (no 30-connection burst).
const EUROPEANA_FANOUT_CONCURRENCY = Number(process.env.EUROPEANA_FANOUT_CONCURRENCY) || 6;
const EUROPEANA_SPARSE_MIN = Number(process.env.EUROPEANA_SPARSE_MIN) || 12;

export async function fetchEuropeana(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const key = process.env.EUROPEANA_API_KEY!;
  const dl = deadline(signal);
  try {
    const base = await fetchEuropeanaBatch(key, q, dl.signal);
    // Base is rich enough — country fan-out would only add discarded noise.
    if (base.length >= EUROPEANA_SPARSE_MIN) return base;

    // Sparse base: fan out per-country to lift recall, then dedupe by record id.
    const extra = await mapPool(EUROPEANA_COUNTRY_FOCUS, EUROPEANA_FANOUT_CONCURRENCY, (country) =>
      fetchEuropeanaBatch(key, q, dl.signal, country),
    );
    const items = [base, ...extra.map((b) => b ?? [])].flat();
    return [...new Map(items.map((item) => [item.id, item])).values()];
  } finally {
    dl.clear();
  }
}

// Harvard Art Museums. Free key: HARVARD_API_KEY
// GOD-FORMAT: capture pixel dims from images[] width/height → ArtItem width/height;
// accessionNumber, classification → artworkType, period/century → style,
// worktypes → tags, secondary images → extra downloads[].
export async function fetchHarvard(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const key = process.env.HARVARD_API_KEY!;
  const dl = deadline(signal);
  try {
    const url =
      `https://api.harvardartmuseums.org/object?apikey=${encodeURIComponent(key)}` +
      `&keyword=${encodeURIComponent(q)}&hasimage=1&size=30&sort=rank`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      records?: Array<{
        id?: unknown; title?: unknown; dated?: unknown;
        people?: Array<{ name?: unknown; role?: unknown }>;
        primaryimageurl?: unknown; iiifbaseuri?: unknown; imagepermissionlevel?: unknown;
        description?: unknown; medium?: unknown; culture?: unknown; creditline?: unknown; url?: unknown;
        accessionNumber?: unknown;
        classification?: unknown;
        period?: unknown;
        century?: unknown;
        worktypes?: Array<{ worktype?: unknown }>;
        images?: Array<{ width?: unknown; height?: unknown; baseimageurl?: unknown; iiifbaseuri?: unknown }>;
      }>;
    };
    const items: ArtItem[] = [];
    for (const r of json.records ?? []) {
      // imagepermissionlevel 0 = freely usable; require a primary image.
      if (Number(r.imagepermissionlevel) !== 0) continue;
      const primary = str(r.primaryimageurl);
      if (!primary) continue;
      const iiif = str(r.iiifbaseuri);
      const date = str(r.dated);
      const artist = (r.people?.find((p) => str(p.role) === 'Artist') ?? r.people?.[0]);

      // GOD-FORMAT: capture pixel dims from images[0].
      const img0 = r.images?.[0];
      const width = img0 ? (Number(img0.width) || undefined) : undefined;
      const height = img0 ? (Number(img0.height) || undefined) : undefined;

      // Secondary images → extra download entries.
      const downloads: Download[] = [{ label: 'Full JPEG', url: primary, format: 'jpeg', lossless: false }];
      if (Array.isArray(r.images) && r.images.length > 1) {
        for (const img of r.images.slice(1)) {
          const imgUrl = str(img.baseimageurl);
          if (imgUrl) downloads.push({ label: 'Additional JPEG', url: imgUrl, format: 'jpeg', lossless: false });
        }
      }

      const accessionNumber = str(r.accessionNumber) || undefined;
      const artworkType = str(r.classification) || undefined;
      const style = str(r.period) || str(r.century) || undefined;
      const worktypeArr = Array.isArray(r.worktypes)
        ? r.worktypes.map((wt) => str(wt.worktype)).filter(Boolean)
        : [];
      const tags = worktypeArr.length ? worktypeArr : undefined;

      items.push({
        id: `harvard-${str(r.id)}`,
        title: (str(r.title) || 'Untitled') + (date ? ` (${date})` : ''),
        artist: artist ? str(artist.name) : '',
        dimensions: '',
        thumbUrl: iiif ? iiifImage(iiif, IIIF.THUMB) : `${primary}?height=843`,
        previewUrl: iiif ? iiifImage(iiif, IIIF.PREVIEW) : primary,
        fullUrl: primary,
        width,
        height,
        format: 'jpeg',
        lossless: false,
        downloads,
        source: 'harvard',
        isPublicDomain: true, // imagepermissionlevel 0
        date,
        medium: str(r.medium),
        culture: str(r.culture),
        creditLine: str(r.creditline),
        description: str(r.description),
        sourceUrl: str(r.url),
        accessionNumber,
        artworkType,
        style,
        tags,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// Smithsonian Open Access (CC0). Free key: SMITHSONIAN_API_KEY
// GOD-FORMAT: map freetext date, physicalDescription, place, creditLine, notes, sourceUrl.
export async function fetchSmithsonian(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const key = process.env.SMITHSONIAN_API_KEY!;
  const dl = deadline(signal);
  try {
    const url =
      `https://api.si.edu/openaccess/api/v1.0/search?api_key=${encodeURIComponent(key)}` +
      `&q=${encodeURIComponent(`${q} AND online_media_type:Images`)}&rows=25`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      response?: { rows?: Array<{
        id?: unknown; title?: unknown;
        content?: {
          freetext?: {
            name?: Array<{ content?: unknown }>;
            date?: Array<{ content?: unknown }>;
            physicalDescription?: Array<{ content?: unknown }>;
            place?: Array<{ content?: unknown }>;
            creditLine?: Array<{ content?: unknown }>;
            notes?: Array<{ content?: unknown }>;
            topic?: Array<{ content?: unknown }>;
          };
          descriptiveNonRepeating?: {
            online_media?: { media?: Array<{ thumbnail?: unknown; content?: unknown; type?: unknown }> };
            record_link?: unknown;
          };
        };
      }> };
    };
    const items: ArtItem[] = [];
    for (const r of json.response?.rows ?? []) {
      const media = r.content?.descriptiveNonRepeating?.online_media?.media ?? [];
      const m = media.find((x) => str(x.type) === 'Images') ?? media[0];
      const thumb = str(m?.thumbnail);
      const full = str(m?.content) || thumb;
      if (!thumb) continue;
      const ft = r.content?.freetext ?? {};
      const artist = first(ft.name?.map((n) => str(n.content)).filter(Boolean));
      const date = ft.date?.[0] ? str(ft.date[0].content) : undefined;
      const medium = ft.physicalDescription?.[0] ? str(ft.physicalDescription[0].content) : undefined;
      const culture = ft.place?.[0] ? str(ft.place[0].content) : undefined;
      const creditLine = ft.creditLine?.[0] ? str(ft.creditLine[0].content) : undefined;
      const description = ft.notes?.[0] ? str(ft.notes[0].content) : undefined;
      const recordLink = str(r.content?.descriptiveNonRepeating?.record_link);
      const sourceUrl = recordLink || undefined;

      // topic → tags.
      const topicArr = Array.isArray(ft.topic)
        ? ft.topic.map((t) => str(t.content)).filter(Boolean)
        : [];
      const tags = topicArr.length ? topicArr : undefined;

      items.push({
        id: `si-${str(r.id)}`,
        title: str(r.title) || 'Untitled',
        artist,
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full || thumb,
        fullUrl: full || thumb,
        format: fmtFromUrl(full || thumb),
        lossless: false,
        downloads: [{ label: 'Full image', url: full || thumb, format: fmtFromUrl(full || thumb), lossless: false }],
        source: 'si',
        isPublicDomain: true, // Smithsonian Open Access is CC0
        date,
        medium,
        culture,
        creditLine,
        description,
        sourceUrl,
        tags,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// Paris Musées (14 Paris museums; GraphQL, free token). PARIS_MUSEES_TOKEN
// GOD-FORMAT: request fieldAuteurs → artist, fieldDateCreation → date,
// fieldTechniquesMatieres → medium, fieldMusee → creditLine.
// NOTE: GraphQL search syntax is best-effort — verify once the token is live.
export async function fetchParisMusees(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const token = process.env.PARIS_MUSEES_TOKEN!;
  const dl = deadline(signal);
  try {
    const query =
      `{ nodeQuery(filter: {conditions: [` +
      `{field: "type", value: "oeuvre"}, ` +
      `{field: "title", operator: LIKE, value: ${JSON.stringify('%' + q + '%')}}` +
      `]}, limit: 15) { entities { entityLabel ... on NodeOeuvre {` +
      ` title` +
      ` fieldVisuelsPrincipals { entity { publicUrl vignette } }` +
      ` fieldOeuvreAuteurs { entity { entityLabel } }` +
      ` fieldDateProduction { startYear endYear century }` +
      ` fieldMateriauxTechnique` +
      ` fieldMusee { entity { name } }` +
      ` } } } }`;
    const res = await fetch('https://apicollections.parismusees.paris.fr/graphql', {
      method: 'POST',
      signal: dl.signal,
      headers: { 'Content-Type': 'application/json', 'auth-token': token, 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ query }),
    }) as unknown as Response;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      data?: { nodeQuery?: { entities?: Array<{
        entityLabel?: unknown; title?: unknown;
        fieldVisuelsPrincipals?: Array<{ entity?: { publicUrl?: unknown; vignette?: unknown } }>;
        fieldOeuvreAuteurs?: Array<{ entity?: { entityLabel?: unknown } }>;
        fieldDateProduction?: { startYear?: unknown; endYear?: unknown; century?: unknown };
        fieldMateriauxTechnique?: unknown;
        fieldMusee?: Array<{ entity?: { name?: unknown } }>;
      }> } };
      errors?: Array<{ message?: unknown }>;
    };
    // Surface GraphQL errors instead of silently returning nothing.
    if (json.errors?.length) throw new Error(`GraphQL: ${str(json.errors[0].message).slice(0, 120)}`);
    const items: ArtItem[] = [];
    for (const e of json.data?.nodeQuery?.entities ?? []) {
      const v = e.fieldVisuelsPrincipals?.[0]?.entity;
      const img = str(v?.publicUrl) || str(v?.vignette);
      if (!img) continue;
      const artist = e.fieldOeuvreAuteurs?.[0]?.entity
        ? str(e.fieldOeuvreAuteurs[0].entity.entityLabel)
        : '';
      const dp = e.fieldDateProduction;
      const date = dp ? (str(dp.startYear) || str(dp.century) || undefined) : undefined;
      const medium = str(e.fieldMateriauxTechnique) || undefined;
      const museum = e.fieldMusee?.[0]?.entity
        ? str(e.fieldMusee[0].entity.name)
        : '';
      items.push({
        id: `parismusees-${str(e.entityLabel)}-${items.length}`,
        title: str(e.title) || str(e.entityLabel) || 'Untitled',
        artist,
        dimensions: '',
        thumbUrl: str(v?.vignette) || img,
        previewUrl: img,
        fullUrl: img,
        format: fmtFromUrl(img),
        lossless: false,
        downloads: [{ label: 'Full image', url: img, format: fmtFromUrl(img), lossless: false }],
        source: 'parismusees',
        isPublicDomain: true,
        date,
        medium,
        creditLine: museum || undefined,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── Dump-backed sources ──────────────────────────────────────────────────────
// Our normalized metadata Parquet on Hugging Face, queried through HF's keyless
// /search. This covers museums that are best harvested offline (MoMA, NGA, MIA).
// Each museum still has a first-class SOURCES entry; the transport/cache below is
// shared so one query does not fan out into repeated HF calls.

export const DUMP_SOURCE_LABELS = {
  moma: 'MoMA',
  nga: 'NGA',
  mia: 'MIA',
  aic: 'AIC',
  cleveland: 'Cleveland',
  wellcome: 'Wellcome',
  smk: 'SMK',
  si: 'Smithsonian',
  wikidata: 'Wikidata',
  met: 'Met',
  loc: 'Library of Congress',
  harvard: 'Harvard',
  europeana: 'Europeana',
} as const satisfies Partial<Record<ArtItem['source'], string>>;

type DumpSourceKey = keyof typeof DUMP_SOURCE_LABELS;

// Cache keyed by (dataset, query) — NOT by source. MoMA/NGA/MIA are typically
// backed by one combined dataset, so without this they'd each fire their own HF
// /search for the same query (3× the slow upstream call). One fetch returns all
// dump-backed rows; each source filters its own out of the shared result.
const dumpSearchCache = new Map<string, Promise<ArtItem[]>>();

// Upstash KV cache for dump search results. Shares the same env vars as the rate
// limiter / analyze cache so no extra configuration is needed. Falls back to the
// in-memory Map when the env vars are absent (e.g. local dev).
// Lazy-initialized once per serverless instance (same pattern as analyze.ts).
let _dumpRedis: {
  get: (k: string) => Promise<unknown>;
  set: (k: string, v: string, o: { ex: number; nx?: boolean }) => Promise<unknown>;
} | null | undefined;

async function getDumpRedis() {
  if (_dumpRedis !== undefined) return _dumpRedis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) { _dumpRedis = null; return null; }
  try {
    const { Redis } = await import('@upstash/redis');
    _dumpRedis = new Redis({ url, token }) as unknown as typeof _dumpRedis;
  } catch { _dumpRedis = null; }
  return _dumpRedis;
}

const DUMP_CACHE_TTL_S = 5 * 60; // 5-minute TTL for dump search results
const DUMP_CACHE_KEY_PREFIX = 'dump-search:';

export function dumpDatasetEnv(source: DumpSourceKey): string {
  return `HARPE_${source.toUpperCase()}_DUMP_DATASET`;
}

export function dumpDatasetFor(source: DumpSourceKey, env: NodeJS.ProcessEnv = process.env): string {
  return env[dumpDatasetEnv(source)] || env.HARPE_DUMP_DATASET || '';
}

export function fetchDumpSearch(dataset: string, q: string): Promise<ArtItem[]> {
  const memKey = `${dataset}\n${q}`;
  // Tier 1: in-memory Map (per-instance, lives only as long as the Lambda is warm).
  let cached = dumpSearchCache.get(memKey);
  if (!cached) {
    // Tier 2: Upstash KV (survives across instances; ~5-minute TTL).
    // Wrap the async KV lookup + upstream fetch in a Promise so the in-memory Map
    // entry is set synchronously and concurrent callers share the same Promise.
    cached = (async () => {
      const redis = await getDumpRedis();
      const kvKey = `${DUMP_CACHE_KEY_PREFIX}${dataset}\n${q}`;
      if (redis) {
        try {
          const hit = await redis.get(kvKey);
          if (hit) {
            return typeof hit === 'string' ? (JSON.parse(hit) as ArtItem[]) : (hit as ArtItem[]);
          }
        } catch { /* ignore KV errors — fall through to live fetch */ }
      }
      const items = await fetchDumpSearchUncached(q, dataset);
      // Populate KV with SET-if-not-exists (NX) to avoid stampede overwrites.
      if (redis) {
        try {
          await redis.set(kvKey, JSON.stringify(items), { ex: DUMP_CACHE_TTL_S, nx: true });
        } catch { /* ignore KV write errors */ }
      }
      return items;
    })();
    dumpSearchCache.set(memKey, cached);
    // Never cache a failed call (breaker-open / exhausted retries) for the life of
    // the warm instance — drop it so the next query can try again.
    cached.catch(() => dumpSearchCache.delete(memKey));
    // Bound the in-memory cache. `while`, not `if`: concurrent invocations can
    // insert several entries before any eviction runs, so a single `if` lets it grow.
    while (dumpSearchCache.size > 32) {
      const oldest = dumpSearchCache.keys().next().value;
      if (!oldest) break;
      dumpSearchCache.delete(oldest);
    }
  }
  return cached;
}

// Per-source query depth. Each of the 13 dump sources is queried INDEPENDENTLY via
// HF /filter (ILIKE), not one shared /search — a single BM25 /search let the text-
// rich Wikidata rows monopolise all 100 slots (97% even at offset 400), starving
// every museum source to 0 results. Per-source querying guarantees diversity.
// 100 = HF /filter's max rows-per-request (free, no billing). Going beyond needs
// offset pagination (the infinite-scroll "load more" feature). Tunable via env.
const DUMP_PER_SOURCE = Math.min(100, Number(process.env.HARPE_DUMP_PER_SOURCE) || 100);

// Single in-flight probe for the notability column (nb_sitelinks, added by the
// ingest enrichment pass) so we can ORDER BY fame. A shared Promise collapses all
// concurrent per-source calls onto ONE probe — no 422 storm across the 13 workers.
// Reset to null on a network error (vs a genuine 422) so a transient blip doesn't
// permanently disable ordering; a fresh deploy after re-ingest re-probes → true.
let _notabilityProbe: Promise<boolean> | null = null;
function probeNotability(withOrder: string, signal: AbortSignal): Promise<boolean> {
  if (_notabilityProbe) return _notabilityProbe;
  _notabilityProbe = (async () => {
    try {
      const r = await timedFetch(withOrder, signal);
      if (r.status === 422) return false;      // column absent (pre-enrich)
      if (!r.ok) { _notabilityProbe = null; return false; } // transient → re-probe later
      return true;
    } catch { _notabilityProbe = null; return false; }
  })();
  return _notabilityProbe;
}

const _sqlEsc = (s: string) => s.replace(/'/g, "''");
const _stripWild = (s: string) => s.toLowerCase().replace(/[%_]/g, '');

// HF /filter WHERE for one source. Restrictive grammar (validated live): supports
// AND/OR/parens/ILIKE with columns in double quotes. Artist must contain EVERY
// query token (so "Rembrandt van Rijn" matches "Rembrandt (Rembrandt van Rijn)"),
// OR the title / depicts label contains the whole phrase (title + theme queries).
// Returns null when the query has no usable content after stripping ILIKE wildcards
// (e.g. "%%") — the caller then skips the HF call instead of issuing a match-all.
export function dumpWhere(source: string, q: string): string | null {
  const toks = q.toLowerCase().split(/\s+/).map((t) => t.replace(/[%_]/g, '')).filter((t) => t.length >= 2).slice(0, 6);
  const fq = _stripWild(q).trim();
  const effective = toks.length ? toks : (fq.length >= 2 ? [fq] : null);
  if (!effective) return null;
  const artist = effective.map((t) => `"artist" ILIKE '%${_sqlEsc(t)}%'`).join(' AND ');
  return `"source"='${_sqlEsc(source)}' AND ((${artist}) OR "title" ILIKE '%${_sqlEsc(fq)}%' OR "depicts_labels" ILIKE '%${_sqlEsc(fq)}%')`;
}

async function dumpFilterRows(
  dataset: string,
  source: string,
  q: string,
  offset = 0,
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const where = dumpWhere(source, q);
  if (!where) return { rows: [], total: 0 }; // degenerate query (all wildcards) → no match-all scan
  const base =
    `https://datasets-server.huggingface.co/filter?dataset=${encodeURIComponent(dataset)}` +
    `&config=default&split=train&where=${encodeURIComponent(where)}&offset=${offset}&length=${DUMP_PER_SOURCE}`;
  const withOrder = `${base}&orderby=${encodeURIComponent('"nb_sitelinks" DESC')}`;
  return dumpHttpPolicy.execute(async ({ signal }) => {
    const ordered = await probeNotability(withOrder, signal);
    const res = await timedFetch(ordered ? withOrder : base, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      rows?: Array<{ row?: Record<string, unknown> }>;
      num_rows_total?: number;
    };
    const rows = (json.rows ?? []).map((r) => r.row).filter((r): r is Record<string, unknown> => !!r);
    return { rows, total: Number(json.num_rows_total) || 0 };
  });
}

/** Map one HF Parquet row → ArtItem. Returns null when mandatory image URLs are absent. */
function rowToItem(
  row: Record<string, unknown>,
  nameMap: Record<string, string>,
  fallbackIndex: number,
): ArtItem | null {
  const httpsify = (u: string) => u.replace(/^http:\/\//i, 'https://');
  const id = str(row.id);
  const thumb = httpsify(str(row.image_thumb) || str(row.image_full));
  const full = httpsify(str(row.image_full) || str(row.image_thumb));
  if (!thumb) return null;
  const source = str(row.source) as ArtItem['source'];
  if (!(source in DUMP_SOURCE_LABELS)) return null;
  const nb = Number(row.nb_sitelinks);
  return {
    id: id || `dumps-${fallbackIndex}`,
    title: str(row.title) || 'Untitled',
    artist: str(row.artist),
    dimensions: str(row.dimensions),
    thumbUrl: thumb,
    previewUrl: full,
    fullUrl: full,
    width: num(row.width),
    height: num(row.height),
    format: fmtFromUrl(full),
    lossless: false,
    downloads: [{ label: 'Full image', url: full, format: fmtFromUrl(full), lossless: false }],
    source,
    isPublicDomain: row.is_public_domain === true,
    date: cleanDate(str(row.date)),
    medium: str(row.medium),
    culture: str(row.culture),
    creditLine: str(row.credit_line),
    description: str(row.description),
    sourceUrl: str(row.source_url),
    provider: DUMP_SOURCE_LABELS[source as DumpSourceKey],
    wikidataId: /^Q\d+$/.test(str(row.wikidata_qid)) ? str(row.wikidata_qid) : undefined,
    artistId: (/^Q\d+$/.test(str(row.artist_qid)) ? str(row.artist_qid) : undefined)
      ?? resolveArtistQid(nameMap, str(row.artist)),
    depicts: str(row.depicts_qids) ? str(row.depicts_qids).split(' ').filter(Boolean) : undefined,
    depictsLabels: parseJsonArray(str(row.depicts_labels)),
    clusterId: typeof row.cluster_id === 'number' ? row.cluster_id : undefined,
    movement: str(row.movement) || undefined,
    nbSitelinks: Number.isFinite(nb) && nb > 0 ? nb : undefined,
  };
}

async function fetchDumpSearchUncached(q: string, dataset: string): Promise<ArtItem[]> {
  const nameMap = await loadNameToQid(); // memoised; {} on miss
  const sources = Object.keys(DUMP_SOURCE_LABELS) as DumpSourceKey[];
  // Query every dump source independently (concurrency-capped to be polite to HF).
  // A source that fails returns []; only if ALL fail do we throw (so a transient
  // outage isn't cached as "no results" for the 5-minute TTL).
  let anyOk = false;
  const perSource = await mapPool(sources, 6, async (s): Promise<Array<Record<string, unknown>>> => {
    try {
      const { rows } = await dumpFilterRows(dataset, s, q);
      anyOk = true;
      return rows;
    } catch (e) { if (isBrokenCircuitError(e)) { return []; } anyOk = anyOk || false; return []; }
  });
  const rows = perSource.flat().filter((r): r is Record<string, unknown> => !!r);
  if (!anyOk && rows.length === 0) throw new Error('all dump sources failed');

  const seen = new Set<string>();
  const items: ArtItem[] = [];
  for (const row of rows) {
    const id = str(row.id);
    if (id && seen.has(id)) continue; // a work can match multiple per-source queries
    if (id) seen.add(id);
    const item = rowToItem(row, nameMap, items.length);
    if (item) items.push(item);
  }
  return items;
}


export async function fetchDumpSource(source: DumpSourceKey, q: string): Promise<ArtItem[]> {
  const dataset = dumpDatasetFor(source);
  if (!dataset) return [];
  try {
    const all = await fetchDumpSearch(dataset, q);
    // Dump sources are pre-capped to DUMP_PER_SOURCE by the /filter length; don't
    // re-clamp to the smaller live-API MAX_ITEMS or we'd throw away dump depth.
    return all.filter((it) => it.source === source).slice(0, DUMP_PER_SOURCE);
  } catch (e) {
    // HF /search breaker open (or its retries exhausted): degrade quietly to no
    // dump results for this query rather than erroring all 9 dump sources.
    if (isBrokenCircuitError(e)) return [];
    throw e;
  }
}

/** A deeper page of dump results for infinite scroll. `page` is 0-based; each page
 *  is DUMP_PER_SOURCE rows/source (offset = page × DUMP_PER_SOURCE), pooled across
 *  all dump sources. `hasMore` = at least one source still has rows beyond this
 *  page; `total` = summed match counts (HF num_rows_total) across sources. */
export async function fetchDumpPage(
  dataset: string,
  q: string,
  page: number,
): Promise<{ items: ArtItem[]; hasMore: boolean; total: number }> {
  const nameMap = await loadNameToQid(); // memoised; {} on miss
  const sources = Object.keys(DUMP_SOURCE_LABELS) as DumpSourceKey[];
  const offset = page * DUMP_PER_SOURCE;

  // Query all sources at the requested offset, concurrency-capped like page-0.
  // A broken-circuit source yields [] + 0 total (quiet degradation). Only throw
  // when ALL sources fail, matching fetchDumpSearchUncached's error tolerance.
  let anyOk = false;
  const perSource = await mapPool(
    sources,
    6,
    async (s): Promise<{ rows: Array<Record<string, unknown>>; total: number }> => {
      try {
        const result = await dumpFilterRows(dataset, s, q, offset);
        anyOk = true;
        return result;
      } catch (e) {
        if (isBrokenCircuitError(e)) return { rows: [], total: 0 };
        anyOk = anyOk || false;
        return { rows: [], total: 0 };
      }
    },
  );

  // Aggregate rows and compute pagination metadata. mapPool yields (R|null)[]
  // (null if a thunk threw — shouldn't happen since we catch, but narrow it).
  const ok = perSource.filter((r): r is { rows: Array<Record<string, unknown>>; total: number } => !!r);
  const allRows = ok.flatMap((r) => r.rows);
  const total = ok.reduce((acc, r) => acc + r.total, 0);
  // hasMore = at least one source has rows beyond the end of this page.
  const hasMore = ok.some((r) => r.total > (page + 1) * DUMP_PER_SOURCE);

  if (!anyOk && allRows.length === 0) throw new Error('all dump sources failed');

  // Dedupe by id (a work can appear in multiple per-source results), then map rows.
  const seen = new Set<string>();
  const items: ArtItem[] = [];
  for (const row of allRows) {
    const id = str(row.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const item = rowToItem(row, nameMap, items.length);
    if (item) items.push(item);
  }

  return { items, hasMore, total };
}

// ─── Knowledge-graph entity files (static JSON on the HF CDN) ──────────────────
// The HF datasets-server /filter WHERE API is broken (HTTP 422), so entity lookup
// uses pre-baked static JSON files served by the HF resolve CDN — a plain HTTPS
// GET, no query engine, no auth. One file per artist/subject QID, produced by the
// ingest entity pass. All run through the shared dumpHttpPolicy (retry + breaker
// + timeout); the handler layer adds the Upstash cache, mirroring the dump path.
const HF_ENTITY_CDN = 'https://huggingface.co/datasets/NullSense/harpe-art/resolve/main/data';

// Artist-name → QID resolution for NON-Wikidata dump rows (which lack the
// artist_qid column), so their cards link to the artist page too. The ingest emits
// only RAW {name: QID} facts; ALL name-matching logic lives HERE (the single
// source of truth — no Python normalize() to keep in sync): we normalize() each
// name, add ≥4-char surname suffixes with a collision guard, and key non-Latin
// names raw. Built once from the CDN map and memoised for the instance's lifetime;
// decoupled from the dump breaker (a miss just means no name-resolution).
let _nameIndex: Record<string, string> | null | undefined;

export function buildNameIndex(raw: Record<string, string>): Record<string, string> {
  const idx: Record<string, string> = {};
  const suffixHits = new Map<string, Set<string>>();
  for (const [name, qid] of Object.entries(raw)) {
    if (!/^Q\d+$/.test(qid)) continue;
    const norm = normalize(name);
    if (norm) {
      if (!(norm in idx)) idx[norm] = qid; // full name, first-wins
      const w = norm.split(' ');
      for (let i = 1; i < w.length; i++) {
        const sfx = w.slice(i).join(' ');
        if (sfx.length >= 4) (suffixHits.get(sfx) ?? suffixHits.set(sfx, new Set()).get(sfx)!).add(qid);
      }
    } else {
      const key = `raw:${name.toLowerCase()}`; // non-Latin (CJK/…) → normalize() empties it
      if (!(key in idx)) idx[key] = qid;
    }
  }
  // add only non-colliding surname suffixes ("van gogh"/"gogh"); a suffix shared by
  // >1 artist is dropped so we never resolve to the wrong person.
  for (const [sfx, qids] of suffixHits) {
    if (qids.size === 1 && !(sfx in idx)) idx[sfx] = [...qids][0];
  }
  return idx;
}

async function loadNameToQid(): Promise<Record<string, string>> {
  if (_nameIndex !== undefined) return _nameIndex ?? {};
  const dl = deadline(undefined);
  try {
    const res = await timedFetch(`${HF_ENTITY_CDN}/name_to_qid.json`, dl.signal);
    const raw = res.ok ? (await res.json() as Record<string, string>) : null;
    _nameIndex = raw ? buildNameIndex(raw) : null;
  } catch { _nameIndex = null; } finally { dl.clear(); }
  return _nameIndex ?? {};
}

/** Resolve a free-text artist name to a Wikidata QID via the built index. */
export function resolveArtistQid(index: Record<string, string>, name: string): string | undefined {
  if (!name) return undefined;
  const q = index[normalize(name)] ?? index[`raw:${name.toLowerCase()}`];
  return q && /^Q\d+$/.test(q) ? q : undefined;
}

/** Strip Wikidata QuickStatements qualifier dumps that leak into some dump `date`
 *  values, e.g. "between 1503 and 1505date QS:P571,+1503-00-00T00:00:00Z/8,P1319,…"
 *  → "between 1503 and 1505". Returns undefined when nothing readable remains. */
export function cleanDate(s: string): string | undefined {
  const d = s
    .replace(/\s*date\s+QS:.*$/is, '') // "…1505date QS:P571,…" → "…1505"
    .replace(/\s*QS:.*$/is, '')        // any other QuickStatements tail
    .trim();
  return d || undefined;
}

/** Parse a JSON-array string column (e.g. depicts_labels) → string[] | undefined. */
function parseJsonArray(s: string): string[] | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  } catch { return undefined; }
}

// Entity files are SHARDED into bucket bundles ({QID: entity} per file) because HF
// caps any directory at 10,000 files (~90k artists → one-file-per-QID overflows).
// bucket = int(QID-digits) % ENTITY_SHARDS — this MUST match the ingest producer
// (enrich_entities.py `_bucket`); both are pinned by parity tests. Changing the
// shard count requires re-running the ingest AND bumping it here in lock-step.
export const ENTITY_SHARDS = 256;
export function entityBucket(qid: string): number {
  const n = parseInt(qid.slice(1), 10);
  return Number.isFinite(n) ? ((n % ENTITY_SHARDS) + ENTITY_SHARDS) % ENTITY_SHARDS : 0;
}

// Memoise fetched bucket bundles (a ~100 KB shard holds ~hundreds of entities) so
// looking up several QIDs in one shard costs one download. Small LRU cap keeps a
// serverless instance's memory bounded; the per-QID Redis cache sits above this.
const _bucketCache = new Map<string, Promise<Record<string, unknown> | null>>();
const _BUCKET_CACHE_MAX = 48;

/** Test-only: drop the in-memory bucket memo so each case fetches fresh. */
export function _resetEntityBucketCache(): void { _bucketCache.clear(); }

function fetchEntityBucket(dir: string, qid: string): Promise<Record<string, unknown> | null> {
  const key = `${dir}/${entityBucket(qid)}`;
  const hit = _bucketCache.get(key);
  if (hit) { _bucketCache.delete(key); _bucketCache.set(key, hit); return hit; } // LRU touch
  const p = dumpHttpPolicy.execute(async ({ signal }) => {
    const res = await timedFetch(`${HF_ENTITY_CDN}/${key}.json`, signal);
    if (res.status === 404) return null; // shard absent → no entity
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  });
  p.catch(() => _bucketCache.delete(key)); // never memoise a failed fetch
  _bucketCache.set(key, p);
  if (_bucketCache.size > _BUCKET_CACHE_MAX) {
    const oldest = _bucketCache.keys().next().value;
    if (oldest !== undefined) _bucketCache.delete(oldest);
  }
  return p;
}

async function fetchShardedEntity<T>(dir: string, qid: string): Promise<T | null> {
  const map = await fetchEntityBucket(dir, qid);
  const v = map?.[qid];
  return v == null ? null : (v as T);
}

/** A knowledge-graph artist node by QID (null if not in the index). */
export function fetchArtistEntity(qid: string): Promise<ArtistEntity | null> {
  return fetchShardedEntity<ArtistEntity>('artists', qid);
}

/** The work ids attributed to an artist QID ([] if none/unknown). */
export async function fetchArtistWorkIds(qid: string): Promise<string[]> {
  const ids = await fetchShardedEntity<string[]>('work_ids_by_artist', qid);
  return Array.isArray(ids) ? ids : [];
}

/** A knowledge-graph subject ("depicts") node by QID (null if not in the index). */
export function fetchSubjectEntity(qid: string): Promise<SubjectEntity | null> {
  return fetchShardedEntity<SubjectEntity>('depicts', qid);
}

// ─── Library of Congress (Prints & Photographs) ──────────────────────────────
// Keyless JSON API: any loc.gov page + ?fo=json. The /photos/ endpoint covers the
// P&P catalog — incl. the FSA/OWI archive (Dorothea Lange, Walker Evans, Russell
// Lee…) and Carol Highsmith, exactly the photographers the painting-heavy sources
// miss. Real derivatives live on tile.loc.gov; largest listed is ~1024px.
// GOD-FORMAT: map item.notes → description, item.subject → tags, item.call_number → accessionNumber.
function locName(raw: string): string {
  // "lange, dorothea" → "Dorothea Lange"
  const s = raw.includes(',') ? raw.split(',').reverse().join(' ') : raw;
  return s.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function fetchLoc(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  const dl = deadline(signal);
  try {
    const url =
      `https://www.loc.gov/photos/?q=${encodeURIComponent(q)}&fo=json&c=20&at=results`;
    const res = await timedFetch(url, dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      results?: Array<{
        title?: unknown; image_url?: unknown; url?: unknown; id?: unknown;
        date?: unknown; contributor?: unknown; unrestricted?: unknown;
        access_restricted?: unknown; item?: Record<string, unknown>;
      }>;
    };
    const clean = (u: string) => u.split('#')[0];
    const items: ArtItem[] = [];
    for (const r of json.results ?? []) {
      const imgs = Array.isArray(r.image_url) ? (r.image_url as unknown[]).map(str) : [];
      const usable = imgs.filter((u) => u.includes('tile.loc.gov')); // skips svg group placeholders
      if (usable.length === 0) continue;
      const lastRaw = usable[usable.length - 1];
      const full = clean(lastRaw);
      const thumb = clean(usable[0]);
      const dm = /[#&]h=(\d+)&w=(\d+)/.exec(lastRaw); // dims from the largest derivative
      const height = dm ? Number(dm[1]) : undefined;
      const width = dm ? Number(dm[2]) : undefined;
      const contributors = Array.isArray(r.contributor) ? (r.contributor as unknown[]).map(str).filter(Boolean) : [];
      const item = (r.item && typeof r.item === 'object') ? r.item : {};
      const med = Array.isArray(item.medium_brief) ? str((item.medium_brief as unknown[])[0])
        : Array.isArray(item.medium) ? str((item.medium as unknown[])[0]) : str(item.medium_brief);
      const sourceUrl = str(r.url) || str(r.id);
      const pd = r.unrestricted === true && r.access_restricted !== true;
      const digits = sourceUrl.replace(/\D+/g, '').slice(0, 12);

      // GOD-FORMAT: map notes → description, subject → tags, call_number → accessionNumber.
      const notes: unknown = item.notes;
      const description: string | undefined = Array.isArray(notes) && notes.length
        ? str((notes as unknown[])[0])
        : typeof notes === 'string' ? notes : undefined;

      const subjectRaw: unknown = item.subject;
      const subjectArr = Array.isArray(subjectRaw)
        ? (subjectRaw as unknown[]).map(str).filter(Boolean)
        : str(subjectRaw) ? [str(subjectRaw as unknown)] : [];
      const tags = subjectArr.length ? subjectArr : undefined;

      const callNumber: unknown = item.call_number;
      const accessionNumber = Array.isArray(callNumber)
        ? str((callNumber as unknown[])[0]) || undefined
        : str(callNumber) || undefined;

      items.push({
        id: `loc-${digits || items.length}`,
        title: str(r.title) || 'Untitled',
        artist: contributors.length ? locName(contributors[0]) : '',
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full,
        fullUrl: full,
        width, height,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'loc',
        isPublicDomain: pd,
        date: str(r.date),
        medium: med,
        sourceUrl,
        description,
        tags,
        accessionNumber,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}

// ─── NYPL (New York Public Library Digital Collections) ──────────────────────
// Keyed (free token, 10k req/day). With publicDomainOnly=true the results carry
// usable imageLinks. Strong photography. Dormant until NYPL_API_TOKEN is set.
// DEFENSIVE: only emits items where a real http(s) image URL was parsed, so a
// shape mismatch degrades to "0 results", never broken tiles.
// GOD-FORMAT: map contributor → artist, dateString → date (not dateDigitized).
function nyplPick(links: string[], codes: string[]): string {
  for (const c of codes) {
    const hit = links.find((u) => new RegExp(`[?&]t=${c}(?:&|$)`).test(u));
    if (hit) return hit;
  }
  return links[0] || '';
}

export async function fetchNypl(q: string, signal?: AbortSignal): Promise<ArtItem[]> {
  // Tolerate a value pasted with surrounding quotes or a `Token token=` prefix.
  const token = (process.env.NYPL_API_TOKEN || process.env.NYPL_API_KEY || '')
    .trim().replace(/^Token\s+token=/i, '').replace(/^["']|["']$/g, '').trim();
  const dl = deadline(signal);
  try {
    // v2 + `Authorization: Token token="…"` is the documented scheme (v1 is now
    // disabled). Must go over HTTP/2 (see h2Agent) — NYPL's HTTP/1.1 path replies
    // "HTTP Basic: Access denied" and ignores the Token scheme.
    const url =
      `https://api.repo.nypl.org/api/v2/items/search?q=${encodeURIComponent(q)}` +
      `&publicDomainOnly=true&per_page=20`;
    const res = await fetch(url, {
      dispatcher: h2Agent(),   // NYPL honours the Token scheme only over HTTP/2
      signal: dl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: `Token token="${token}"` },
    } as Parameters<typeof fetch>[1]) as unknown as Response;
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${b.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    const json = await res.json() as { nyplAPI?: { response?: { result?: unknown } } };
    const raw = json.nyplAPI?.response?.result;
    const results = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const items: ArtItem[] = [];
    for (const r0 of results) {
      const r = r0 as Record<string, unknown>;
      const ilNode = (r.imageLinks && typeof r.imageLinks === 'object')
        ? (r.imageLinks as Record<string, unknown>).imageLink : undefined;
      let links = (Array.isArray(ilNode) ? ilNode.map(str) : ilNode ? [str(ilNode)] : [])
        .map((u) => u.replace(/&amp;/g, '&').trim())      // NYPL HTML-encodes & in links
        .map((u) => (u.startsWith('//') ? `https:${u}` : u))
        .filter((u) => /^https?:/i.test(u));
      const imageID = str(r.imageID);
      if (links.length === 0 && imageID) links = [`https://images.nypl.org/index.php?id=${imageID}&t=w`];
      const full = nyplPick(links, ['g', 'v', 'q', 'w']);
      if (!/^https?:/i.test(full)) continue; // safety: never emit a broken tile
      const thumb = nyplPick(links, ['w', 'r', 't']) || full;
      const uuid = str(r.uuid);

      // GOD-FORMAT: use dateString (not dateDigitized), map contributor → artist,
      // physicalDescription → medium, note → description, subject → tags.
      const contribNode = r.contributor;
      let artist = '';
      if (Array.isArray(contribNode)) {
        artist = str(contribNode[0]);
      } else if (contribNode) {
        artist = str(contribNode);
      }
      const dateStr = str(r.dateString) || str(r.dateDigitized);

      const physDescNode = r.physicalDescription;
      const medium = Array.isArray(physDescNode)
        ? str((physDescNode as unknown[])[0]) || undefined
        : str(physDescNode) || undefined;

      const noteNode = r.note;
      const description = Array.isArray(noteNode)
        ? str((noteNode as unknown[])[0]) || undefined
        : str(noteNode) || undefined;

      const subjectNode = r.subject;
      const subjectArr = Array.isArray(subjectNode)
        ? (subjectNode as unknown[]).map(str).filter(Boolean)
        : str(subjectNode) ? [str(subjectNode)] : [];
      const tags = subjectArr.length ? subjectArr : undefined;

      items.push({
        id: `nypl-${uuid || items.length}`,
        title: str(r.title) || 'Untitled',
        artist,
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full,
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full image', url: full, format: 'jpeg', lossless: false }],
        source: 'nypl',
        isPublicDomain: true,
        date: dateStr || undefined,
        sourceUrl: uuid ? `https://digitalcollections.nypl.org/items/${uuid}` : '',
        medium,
        description,
        tags,
      });
    }
    return items;
  } finally {
    dl.clear();
  }
}
