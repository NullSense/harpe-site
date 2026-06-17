/**
 * Finder — the one search box for the whole site.
 *
 * Type anything:
 *   • a page / gallery URL   → server scans it and lists every image (pick & download)
 *   • a IIIF manifest URL    → resolves the zoomable image
 *   • a title or artist name  → federated museum search (AIC, Met, Cleveland,
 *                                Commons, WikiArt)
 *
 * Both result kinds render in the same grid and open the same ArtDetail view,
 * and every download goes through the same /api/fetch proxy.
 */

import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DownloadMenu from './components/DownloadMenu';
import SearchSuggest from './components/SearchSuggest';
import Discover from './components/Discover';
import { streamArt } from './lib/useArtStream';
import { fitsScreen } from './lib/resolutions';
import { qualityScore, stripHtml, mediumCategory, yearOf } from './lib/ranking';
import { rankResults } from './lib/search';
import {
  type DeepZoomDescriptor,
  osdTileSource,
  thumbUrl as dzThumbUrl,
  stitchToBlob,
  stitchLevel,
  levelDimensions,
} from './lib/deepzoom';
import {
  type DownloadVariant,
  LOSSLESS_FORMATS,
  displaySrc,
  downloadViaProxy,
  fmtFromUrl,
  isURL,
  safeName,
} from './lib/media';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ImageCandidate {
  url: string;
  name: string;
  width?: number;
}
interface ScanImage extends ImageCandidate {
  naturalWidth: number; // -1 until the <img> loads
  loaded: boolean;
}

interface ArtItem {
  id: string;
  title: string;
  artist: string;
  dimensions?: string;
  thumbUrl: string;
  previewUrl: string;
  fullUrl: string;
  width?: number;
  height?: number;
  format: string;
  lossless: boolean;
  downloads: DownloadVariant[];
  source: 'aic' | 'met' | 'cleveland' | 'commons' | 'wikiart' | 'vam' | 'wellcome' | 'smk' | 'nasjonalmuseet' | 'digitalnz' | 'wikidata' | 'europeana' | 'harvard' | 'si' | 'parismusees' | 'moma' | 'nga' | 'mia' | 'loc' | 'nypl' | 'dumps' | 'iiif' | 'scan';
  isPublicDomain: boolean;
  date?: string;
  medium?: string;
  culture?: string;
  creditLine?: string;
  description?: string;
  sourceUrl?: string;
  /** Present for zoomable/gigapixel images (DZI/Zoomify/IIIF) — drives OSD deep-zoom
   *  and our in-browser full-resolution tile-stitch download. */
  deepzoom?: DeepZoomDescriptor;
  /** Present for video posts (X/Twitter, cobalt-resolved sites) — drives the
   *  <video> player + download instead of the image viewer. `direct` means the
   *  url already serves as an attachment (cobalt tunnel) so download is a plain
   *  anchor; otherwise it's pulled through /api/fetch to force the attachment. */
  video?: { poster: string; best: string; variants: Array<{ label: string; url: string; bitrate: number }>; direct?: boolean };
}

// Normalize a (title, artist) into a key for grouping the same work across sources.
function workKey(it: { title: string; artist: string }): string {
  const t = it.title.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const a = it.artist.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${t}|${a}`;
}

interface SauceResult {
  similarity: number;
  thumbnail: string;
  title: string;
  author: string;
  site: string;
  urls: string[];
}

type Mode = 'idle' | 'loading' | 'scan' | 'art' | 'empty' | 'error';
type DlStatus = 'downloading' | 'done' | 'error';

const MIN_WIDTH = 100;
const SHOWN_STEP = 24; // infinite-scroll page size

// Client-side ranking — mirrors /api/art. Results from many museum APIs are merged
// with Reciprocal Rank Fusion (shared src/lib/search.ts `fuse`): each source's own
// ranking is preserved and fused with an IDF-weighted, name-aware, fuzzy relevance
// leg + a quality prior + a cross-source consensus boost. So the streamed view
// stays relevance-first instead of arrival order.
// Stable display order for the source-filter chips (ranking itself is handled by
// the RRF `fuse`, which preserves each source's own ordering).
const SOURCE_ORDER: Record<string, number> = {
  aic: 0, met: 1, cleveland: 2, vam: 3, wellcome: 4, smk: 5, nasjonalmuseet: 6,
  parismusees: 7, harvard: 8, europeana: 9, si: 10, moma: 11, nga: 12, mia: 13, loc: 14,
  nypl: 15, dumps: 16, wikidata: 17, digitalnz: 18, wikiart: 19, commons: 20,
};

function rankArt(items: ArtItem[], q: string): ArtItem[] {
  return rankResults(items, q, { qualityOf: (it) => qualityScore(it, q) });
}

const IIIF_MANIFEST_RE = /https?:\/\/[^/]+(?:\/[^?#]*)?(?:manifest|info\.json)(?:[?#].*)?$/i;
const IIIF_INFO_RE = /^https?:\/\/.+\/info\.json$/i;
const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif|avif|tiff?|bmp)(?:[?#]|$)/i;
// A DeepZoom (.dzi) or Zoomify (ImageProperties.xml) descriptor pasted directly.
const DEEPZOOM_DESC_RE = /(\.dzi|ImageProperties\.xml)(?:[?#].*)?$/i;
// An X / Twitter post URL → its numeric status id.
const X_STATUS_RE = /(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i;
// Hosts a self-hosted cobalt instance can grab (routed via /api/grab). X is handled
// natively above; the rest need cobalt (configured via COBALT_API_URL) or the CLI.
const MEDIA_HOST_RE = /(?:^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|reddit\.com|redd\.it|vimeo\.com|soundcloud\.com|twitch\.tv|facebook\.com|fb\.watch|pinterest\.|tumblr\.com|bilibili\.com|dailymotion\.com|streamable\.com|bsky\.app|vk\.com)/i;

// Turn an X/Twitter post's resolved media into downloadable ArtItems (video →
// <video> player + MP4 quality picker; photo → normal image).
interface XMedia { type: 'video' | 'photo'; url?: string; poster?: string; best?: string; variants?: Array<{ label: string; url: string; bitrate: number }>; }
function xMediaToItems(data: { id: string; text?: string; author?: string; media?: XMedia[] }, tweetUrl: string): ArtItem[] {
  const title = (data.text || '').replace(/\s*https?:\/\/\S+\s*$/i, '').trim().slice(0, 90) || 'X post';
  const artist = data.author || '';
  const out: ArtItem[] = [];
  (data.media || []).forEach((m, i) => {
    if (m.type === 'video' && m.best && m.variants?.length) {
      out.push({
        id: `x:${data.id}:v${i}`, title, artist,
        thumbUrl: m.poster || '', previewUrl: m.poster || '', fullUrl: m.best,
        format: 'mp4', lossless: false,
        downloads: m.variants.map((v) => ({ label: v.label, url: v.url, format: 'mp4', lossless: false })),
        source: 'scan', isPublicDomain: false, sourceUrl: tweetUrl,
        video: { poster: m.poster || '', best: m.best, variants: m.variants },
      });
    } else if (m.type === 'photo' && m.url) {
      const fmt = fmtFromUrl(m.url);
      out.push({
        id: `x:${data.id}:p${i}`, title, artist,
        thumbUrl: m.url, previewUrl: m.url, fullUrl: m.url,
        format: fmt, lossless: LOSSLESS_FORMATS.has(fmt),
        downloads: [{ label: 'Image', url: m.url, format: fmt, lossless: LOSSLESS_FORMATS.has(fmt) }],
        source: 'scan', isPublicDomain: false, sourceUrl: tweetUrl,
      });
    }
  });
  return out;
}

// Turn cobalt-resolved media (video/audio/photo) into downloadable ArtItems.
interface CobaltMedia { type: 'video' | 'audio' | 'photo'; url: string; filename?: string; thumb?: string; }
function cobaltMediaToItems(data: { media?: CobaltMedia[] }, pageUrl: string): ArtItem[] {
  const out: ArtItem[] = [];
  (data.media || []).forEach((m, i) => {
    if (m.type === 'photo') {
      const fmt = fmtFromUrl(m.url);
      out.push({
        id: `grab:p${i}:${m.url.slice(-24)}`, title: m.filename?.replace(/\.[^.]+$/, '') || 'Image', artist: '',
        thumbUrl: m.url, previewUrl: m.url, fullUrl: m.url, format: fmt, lossless: LOSSLESS_FORMATS.has(fmt),
        downloads: [{ label: 'Image', url: m.url, format: fmt, lossless: LOSSLESS_FORMATS.has(fmt) }],
        source: 'scan', isPublicDomain: false, sourceUrl: pageUrl,
      });
    } else {
      out.push({
        id: `grab:v${i}:${m.url.slice(-24)}`, title: m.filename?.replace(/\.[^.]+$/, '') || (m.type === 'audio' ? 'Audio' : 'Video'), artist: '',
        thumbUrl: m.thumb || '', previewUrl: m.thumb || '', fullUrl: m.url, format: m.type === 'audio' ? 'm4a' : 'mp4', lossless: false,
        downloads: [{ label: 'Download', url: m.url, format: m.type === 'audio' ? 'm4a' : 'mp4', lossless: false }],
        source: 'scan', isPublicDomain: false, sourceUrl: pageUrl,
        video: { poster: m.thumb || '', best: m.url, variants: [{ label: 'Download', url: m.url, bitrate: 0 }], direct: true },
      });
    }
  });
  return out;
}

// Turn a detected zoomable-image descriptor into an ArtItem that opens in the
// OpenSeadragon deep-zoom viewer and offers our in-browser full-res stitch.
function deepzoomItem(d: DeepZoomDescriptor, pageUrl?: string): ArtItem {
  return {
    id: `dz:${d.sourceUrl || d.base}`,
    title: d.title || 'Zoomable image',
    artist: '',
    thumbUrl: dzThumbUrl(d),
    previewUrl: dzThumbUrl(d),
    fullUrl: d.sourceUrl || d.base,
    width: d.width,
    height: d.height,
    format: d.format === 'png' ? 'png' : 'jpeg',
    lossless: d.format === 'png',
    downloads: [],
    source: 'iiif',
    isPublicDomain: true,
    sourceUrl: pageUrl || d.sourceUrl,
    deepzoom: d,
  };
}

// ─── IIIF resolution (client-side, CORS-open servers) ──────────────────────────

async function resolveIIIF(rawUrl: string): Promise<ArtItem | null> {
  let infoUrl = rawUrl;
  if (!IIIF_INFO_RE.test(rawUrl)) {
    try {
      const manifestRes = await fetch(rawUrl);
      if (!manifestRes.ok) return null;
      const manifest = await manifestRes.json();
      const img2 = manifest?.sequences?.[0]?.canvases?.[0]?.images?.[0]?.resource?.service?.['@id'];
      const img3 =
        manifest?.items?.[0]?.items?.[0]?.items?.[0]?.body?.service?.[0]?.['@id'] ??
        manifest?.items?.[0]?.items?.[0]?.items?.[0]?.body?.service?.['@id'];
      const serviceId = img2 || img3;
      if (!serviceId) return null;
      infoUrl = `${serviceId.replace(/\/$/, '')}/info.json`;
    } catch {
      return null;
    }
  }
  try {
    const infoRes = await fetch(infoUrl);
    if (!infoRes.ok) return null;
    const info = await infoRes.json();
    const id: string = info['@id'] || info.id || infoUrl.replace('/info.json', '');
    const base = id.replace(/\/$/, '');
    const fullUrl = `${base}/full/full/0/default.jpg`;
    const label = info.label;
    const title =
      typeof label === 'string' ? label : label?.en?.[0] ?? label?.none?.[0] ?? 'IIIF image';
    return {
      id: `iiif:${id}`,
      title: typeof title === 'string' ? title : 'IIIF image',
      artist: '',
      thumbUrl: `${base}/full/400,/0/default.jpg`,
      previewUrl: `${base}/full/1200,/0/default.jpg`,
      fullUrl,
      format: 'jpeg',
      lossless: false,
      downloads: [{ label: 'Full JPEG', url: fullUrl, format: 'jpeg', lossless: false }],
      source: 'iiif',
      isPublicDomain: true,
    };
  } catch {
    return null;
  }
}

function normalizeArt(raw: unknown): ArtItem {
  const d = raw as Record<string, unknown>;
  const fmt = typeof d.format === 'string' ? d.format : 'jpeg';
  const rawDownloads = Array.isArray(d.downloads) ? d.downloads : [];
  const downloads: DownloadVariant[] = rawDownloads
    .map((x: unknown): DownloadVariant => {
      const v = x as Record<string, unknown>;
      const f = typeof v.format === 'string' ? v.format : 'jpeg';
      return {
        label: typeof v.label === 'string' ? v.label : 'Download',
        url: typeof v.url === 'string' ? v.url : '',
        format: f,
        lossless: typeof v.lossless === 'boolean' ? v.lossless : LOSSLESS_FORMATS.has(f),
      };
    })
    .filter((v) => v.url);
  const thumbUrl = typeof d.thumbUrl === 'string' ? d.thumbUrl : String(d.thumbUrl ?? '');
  const fullUrl = typeof d.fullUrl === 'string' ? d.fullUrl : String(d.fullUrl ?? '');
  const txt = (k: string) => {
    const val = typeof d[k] === 'string' ? stripHtml(d[k] as string) : '';
    return val || undefined;
  };
  return {
    id: typeof d.id === 'string' ? d.id : String(d.id ?? ''),
    title: txt('title') ?? 'Untitled',
    artist: txt('artist') ?? '',
    dimensions: txt('dimensions'),
    thumbUrl,
    previewUrl: typeof d.previewUrl === 'string' && d.previewUrl ? d.previewUrl : fullUrl || thumbUrl,
    fullUrl,
    width: typeof d.width === 'number' ? d.width : undefined,
    height: typeof d.height === 'number' ? d.height : undefined,
    format: fmt,
    lossless: typeof d.lossless === 'boolean' ? d.lossless : downloads.some((v) => v.lossless),
    downloads: downloads.length ? downloads : [{ label: 'Download', url: fullUrl, format: fmt, lossless: false }],
    source: (d.source as ArtItem['source']) || 'aic',
    isPublicDomain: Boolean(d.isPublicDomain),
    date: txt('date'),
    medium: txt('medium'),
    culture: txt('culture'),
    creditLine: txt('creditLine'),
    description: txt('description'),
    sourceUrl: typeof d.sourceUrl === 'string' && d.sourceUrl ? d.sourceUrl : undefined,
  };
}

// ─── Small UI atoms ────────────────────────────────────────────────────────────

function Spinner({ small = false }: { small?: boolean }) {
  const sz = small ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block ${sz} animate-spin rounded-full border-2 border-bronze/30 border-t-bronze`}
    />
  );
}

function SkeletonCard() {
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-[rgba(16,11,8,.6)]">
      <div className="aspect-[4/3] animate-pulse bg-bronze/10" />
      <div className="mx-3 my-3 h-5 animate-pulse rounded bg-bronze/10" />
    </div>
  );
}

function PreviewBadge() {
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
      <span className="rounded-full bg-[rgba(10,8,6,.7)] px-2.5 py-1 font-mono text-[.66rem] text-bronze-bright backdrop-blur-sm">
        ⤢ preview
      </span>
    </span>
  );
}

// ─── Art card (search mode: per-variant downloads + metadata, click to preview) ─

const SOURCE_LABELS: Record<string, string> = {
  aic: 'AIC', met: 'Met', cleveland: 'Cleveland', commons: 'Commons', wikiart: 'WikiArt', vam: 'V&A', wellcome: 'Wellcome', smk: 'SMK', nasjonalmuseet: 'Nasjonalmus.', digitalnz: 'DigitalNZ', wikidata: 'Wikidata', europeana: 'Europeana', harvard: 'Harvard', si: 'Smithsonian', parismusees: 'Paris Musées', moma: 'MoMA', nga: 'NGA', mia: 'MIA', loc: 'Library of Congress', nypl: 'NYPL', dumps: 'Open data', iiif: 'IIIF', scan: 'Web page',
};
function SourceBadge({ source }: { source: ArtItem['source'] }) {
  return (
    <span className="shrink-0 rounded-sm bg-bronze/15 px-1.5 py-0.5 font-mono text-[.65rem] text-bronze">
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

function ArtCard({
  item, onOpen, selected, onToggleSelect, dlStatus, onImgLoad, onImgError,
}: {
  item: ArtItem;
  onOpen: () => void;
  selected?: boolean;             // scan mode: multi-select
  onToggleSelect?: () => void;    // present → render a selection checkbox
  dlStatus?: DlStatus;
  onImgLoad?: (w: number, h: number) => void;
  onImgError?: () => void;
}) {
  // SMK-style tile: image-dominant, natural aspect (no crop), minimal label. The
  // whole tile opens the detail view (full-size zoom + all metadata + actions).
  // The SAME tile is used for museum art AND scanned-page images.
  const ring = selected ? 'ring-2 ring-bronze' : 'ring-1 ring-line/25 hover:ring-bronze/50';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      aria-label={`Open ${item.title}`}
      className={`group relative mb-4 block w-full cursor-pointer break-inside-avoid overflow-hidden rounded-lg bg-[rgba(16,11,8,.4)] text-left outline-none transition focus-visible:ring-2 focus-visible:ring-bronze/60 ${ring}`}
    >
      <div className="relative bg-[rgba(10,8,6,.8)]">
        <img
          src={displaySrc(item.thumbUrl)}
          alt={`${item.title}${item.artist ? `, by ${item.artist}` : ''}`}
          loading="lazy"
          decoding="async"
          className="block h-auto w-full transition-transform duration-500 group-hover:scale-[1.03]"
          onLoad={(e) => onImgLoad?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; onImgError?.(); }}
        />
        <PreviewBadge />
        {item.video && (
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(10,8,6,.6)] text-xl text-ink/90 backdrop-blur-sm transition group-hover:bg-bronze/30">▶</span>
          </span>
        )}
        {onToggleSelect && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
            aria-pressed={selected}
            aria-label={selected ? 'Deselect' : 'Select'}
            className={'absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full text-[.72rem] font-bold transition ' + (selected ? 'bg-bronze text-[rgba(10,8,6,1)]' : 'border border-line bg-[rgba(10,8,6,.75)] text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:border-bronze/60')}
          >
            {selected ? '✓' : ''}
          </button>
        )}
        {!item.isPublicDomain && item.source !== 'scan' && (
          <span className="absolute right-2 top-2 rounded-sm bg-[rgba(10,8,6,.82)] px-1.5 py-0.5 font-mono text-[.6rem] text-muted">© rights</span>
        )}
        {item.width && item.height && fitsScreen(item.width, item.height) && (
          <span title="Big enough for a crisp wallpaper at your screen resolution" className="absolute bottom-2 left-2 rounded-sm bg-[rgba(10,8,6,.82)] px-1.5 py-0.5 font-mono text-[.58rem] text-bronze-bright">▣ wallpaper</span>
        )}
        {dlStatus && (
          <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-sm bg-[rgba(10,8,6,.88)] px-1.5 py-0.5 font-mono text-[.6rem] text-bronze">
            {dlStatus === 'downloading' && <><Spinner small />fetching…</>}
            {dlStatus === 'done' && '✓ saved'}
            {dlStatus === 'error' && '⚠ error'}
          </span>
        )}
      </div>
      <div className="flex items-start justify-between gap-2 px-2.5 py-2">
        <div className="min-w-0">
          <h3 className="line-clamp-2 font-display text-[.84rem] font-medium leading-snug text-ink" title={item.title}>{item.title}</h3>
          {item.artist && <p className="mt-0.5 truncate text-[.74rem] text-muted">{item.artist}</p>}
        </div>
        <SourceBadge source={item.source} />
      </div>
    </div>
  );
}

// ─── Art detail (combo: full-size zoom + ALL metadata + actions) ───────────────

// A IIIF Image-API URL → its service base (info.json lives there). When present
// we render OpenSeadragon for true tiled gigapixel deep-zoom (AIC, NGA, Harvard,
// Wellcome, raw IIIF…); otherwise we fall back to the plain <img> zoom.
function deriveIIIF(url: string): string | null {
  const m = /^(https?:\/\/.+?)\/full\/(?:full|max|pct:\d+|!?\d+,\d*|\d*,\d+)\/0\/(?:default|native|color)\.(?:jpe?g|png|webp|tif)/i.exec(url);
  return m ? m[1] : null;
}

function ArtDetail({
  items, index, onClose, onIndex, onAnalyze, onShare, onSearch, onFindSource, analyzeEnabled,
}: {
  items: ArtItem[];
  index: number;               // -1 = closed
  onClose: () => void;
  onIndex: (i: number) => void;
  onAnalyze: (it: ArtItem) => void;
  onShare: (id: string) => void;
  onSearch: (q: string) => void;
  onFindSource?: (url: string) => void;
  analyzeEnabled: boolean;
}) {
  const open = index >= 0 && index < items.length;
  const active = open ? items[index] : undefined;
  // Deep-zoom items (our own DZI/Zoomify/IIIF stitcher) take priority; otherwise
  // fall back to deriving a IIIF Image-API base from a museum item's full URL.
  const dz = active?.deepzoom ?? null;
  const iiifBase = active && !dz ? deriveIIIF(active.fullUrl) : null;
  const [z, setZ] = useState(1);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null); // measured pixels
  // OpenSeadragon (tiled deep-zoom) for IIIF/DZI/Zoomify items; <img> fallback.
  const osdRef = useRef<HTMLDivElement>(null);
  const [osdFailed, setOsdFailed] = useState(false);
  const useOsd = open && (!!iiifBase || !!dz) && !osdFailed;
  const dzKey = dz ? `${dz.protocol}:${dz.base}` : '';
  useEffect(() => { setOsdFailed(false); }, [index]);
  useEffect(() => {
    if (!open || (!iiifBase && !dz) || osdFailed) return;
    let viewer: { destroy: () => void; addHandler: (e: string, f: () => void) => void; world: { getItemAt: (i: number) => { getContentSize: () => { x: number; y: number } } | undefined } } | undefined;
    let cancelled = false;
    (async () => {
      try {
        let tileSources: unknown;
        if (dz) {
          // DZI/Zoomify → custom tile source straight from the descriptor.
          tileSources = osdTileSource(dz);
        } else {
          // IIIF → fetch the CORS-proxied info.json, then route its TILES through
          // /api/tile by rewriting @id. Many IIIF servers (e.g. artic.edu) return
          // 403 for direct cross-origin tile requests (no Referer), which the
          // browser blocks via ORB → a blank viewer. OSD appends "/region/size/…"
          // to @id, so pointing @id at /api/tile?url=<base> sends every tile
          // through our proxy (same-origin: no ORB; proxy adds a Referer: no 403).
          const info = await fetch(`/api/iiif?url=${encodeURIComponent(`${iiifBase}/info.json`)}`).then((r) => r.json());
          if (cancelled) return;
          const proxied = `${location.origin}/api/tile?url=${iiifBase}`;
          info['@id'] = proxied;
          info.id = proxied;
          tileSources = info;
        }
        const { default: OSD } = await import('openseadragon');
        if (cancelled || !osdRef.current) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        viewer = (OSD as any)({
          element: osdRef.current,
          tileSources,
          showNavigationControl: false,
          gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
          visibilityRatio: 1,
          minZoomImageRatio: 0.85,
          maxZoomPixelRatio: 5,
          animationTime: 0.4,
        });
        viewer!.addHandler('open', () => {
          const t = viewer!.world.getItemAt(0);
          if (t) { const s = t.getContentSize(); setNat({ w: Math.round(s.x), h: Math.round(s.y) }); }
        });
        viewer!.addHandler('open-failed', () => { if (!cancelled) setOsdFailed(true); });
      } catch {
        if (!cancelled) setOsdFailed(true);
      }
    })();
    return () => { cancelled = true; try { viewer?.destroy(); } catch { /* noop */ } };
  }, [open, iiifBase, dz, dzKey, osdFailed, index]);
  // ── Full-resolution tile-stitch download (DZI/Zoomify deep-zoom items) ──
  const [stitch, setStitch] = useState<
    null | { phase: 'busy' | 'done' | 'error'; done: number; total: number; w?: number; h?: number; msg?: string }
  >(null);
  const stitchAbort = useRef<AbortController | null>(null);
  useEffect(() => { setStitch(null); stitchAbort.current?.abort(); }, [index]);
  const runStitch = useCallback(async () => {
    if (!dz) return;
    stitchAbort.current?.abort();
    const ac = new AbortController();
    stitchAbort.current = ac;
    setStitch({ phase: 'busy', done: 0, total: 0 });
    try {
      const { blob, width, height } = await stitchToBlob(dz, {
        signal: ac.signal,
        onProgress: (done, total) => setStitch((s) => (s && s.phase === 'busy' ? { ...s, done, total } : s)),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stem = (active?.title || 'image').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'image';
      a.href = url;
      a.download = `${stem}_${width}x${height}.${dz.format === 'png' ? 'png' : 'jpg'}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      setStitch({ phase: 'done', done: 1, total: 1, w: width, h: height });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') { setStitch(null); return; }
      setStitch({ phase: 'error', done: 0, total: 0, msg: e instanceof Error ? e.message : 'Stitch failed' });
    }
  }, [dz, active]);

  // Pan is kept in a ref and applied to the <img> imperatively, so dragging does
  // NOT re-render the whole overlay on every pointer-move (that was the lag).
  const imgRef = useRef<HTMLImageElement>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const drag = useRef<null | { sx: number; sy: number; px: number; py: number }>(null);
  const apply = useCallback((zoom: number) => {
    if (imgRef.current) imgRef.current.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoom})`;
  }, []);

  useEffect(() => { panRef.current = { x: 0, y: 0 }; setZ(1); setNat(null); }, [index]);
  useEffect(() => { apply(z); }, [z, apply]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index, items.length, onClose, onIndex]);

  if (!open) return null;
  const item = items[index];
  // Resolution for ALL images: prefer source-reported pixels, else what we measured
  // from the loaded image (so every work shows a resolution, not just some sources).
  const resolution =
    item.width && item.height ? `${item.width} × ${item.height} px`
    : nat ? `${nat.w} × ${nat.h} px`
    : '';
  // "More like this" from the items already on screen: same artist → title-token
  // overlap → same source. Works for both museum art and scanned-page images.
  const similar = (() => {
    const seen = new Set([item.id]);
    const out: ArtItem[] = [];
    const add = (it: ArtItem) => { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } };
    if (item.artist) for (const it of items) if (it.artist === item.artist) add(it);
    const toks = item.title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (toks.length) for (const it of items) if (toks.some((t) => it.title.toLowerCase().includes(t))) add(it);
    for (const it of items) if (it.source === item.source) add(it);
    return out.slice(0, 6);
  })();
  const onWheel = (e: React.WheelEvent) => {
    const next = Math.min(6, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (next === 1) panRef.current = { x: 0, y: 0 };
    apply(next);
    setZ(next);
  };

  const imgHandlers = useOsd ? {} : {
    onWheel,
    onDoubleClick: () => { const n = z > 1 ? 1 : 2.4; if (n === 1) panRef.current = { x: 0, y: 0 }; apply(n); setZ(n); },
    onPointerDown: (e: React.PointerEvent) => { if (z > 1) { drag.current = { sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } },
    onPointerMove: (e: React.PointerEvent) => { if (drag.current) { panRef.current = { x: drag.current.px + (e.clientX - drag.current.sx), y: drag.current.py + (e.clientY - drag.current.sy) }; apply(z); } },
    onPointerUp: () => { drag.current = null; },
    style: { cursor: z > 1 ? 'grab' : 'zoom-in' } as React.CSSProperties,
  };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={item.title} className="fixed inset-0 z-[70] flex flex-col bg-[rgba(8,6,4,.96)] backdrop-blur-sm lg:flex-row">
      {/* image stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" {...imgHandlers}>
        {item.video ? (
          <video
            src={item.video.best}
            poster={item.video.poster}
            controls
            autoPlay
            muted
            loop
            playsInline
            className="max-h-full max-w-full select-none object-contain"
          />
        ) : useOsd ? (
          // h-full w-full (not just inset-0): OSD forces position:relative on its
          // host, which would void inset-0 and collapse the container to 0×0.
          <div ref={osdRef} className="absolute inset-0 h-full w-full" />
        ) : (
          <img
            ref={imgRef}
            /* zoomed in → load the full-resolution original (unless it's a TIFF the
               browser can't render) so deep zoom is sharp, not a blurry preview. */
            src={displaySrc(z > 1 && item.fullUrl && item.format !== 'tiff' ? item.fullUrl : (item.previewUrl || item.fullUrl))}
            alt={item.title}
            draggable={false}
            onLoad={(e) => { setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); apply(z); }}
            className="max-h-full max-w-full select-none object-contain transition-transform duration-75"
          />
        )}
        {/* prev / next */}
        {index > 0 && (
          <button type="button" onClick={() => onIndex(index - 1)} aria-label="Previous" className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-line bg-[rgba(10,8,6,.7)] px-3 py-2 text-ink/80 transition hover:border-bronze/60 hover:text-bronze-bright">‹</button>
        )}
        {index < items.length - 1 && (
          <button type="button" onClick={() => onIndex(index + 1)} aria-label="Next" className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-line bg-[rgba(10,8,6,.7)] px-3 py-2 text-ink/80 transition hover:border-bronze/60 hover:text-bronze-bright">›</button>
        )}
        {/* zoom controls (img mode only — OSD has its own scroll/pinch) + counter */}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 font-mono text-[.72rem]">
          {!useOsd && <button type="button" onClick={() => { const n = Math.max(1, z / 1.4); if (n === 1) panRef.current = { x: 0, y: 0 }; apply(n); setZ(n); }} className="rounded border border-line bg-[rgba(10,8,6,.7)] px-2 py-1 text-muted hover:text-bronze-bright">−</button>}
          {!useOsd && <button type="button" onClick={() => { const n = Math.min(6, z * 1.4); apply(n); setZ(n); }} className="rounded border border-line bg-[rgba(10,8,6,.7)] px-2 py-1 text-muted hover:text-bronze-bright">+</button>}
          <span className="rounded bg-[rgba(10,8,6,.7)] px-2 py-1 text-muted/70">{index + 1} / {items.length}{useOsd ? ' · deep-zoom' : ''}</span>
        </div>
      </div>

      {/* metadata rail */}
      <aside className="flex max-h-[42vh] w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-line bg-[rgba(14,10,7,.92)] p-5 lg:max-h-none lg:w-[380px] lg:border-l lg:border-t-0">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-display text-[1.15rem] font-medium leading-snug text-ink">{item.title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-md border border-line px-2 py-0.5 font-mono text-muted transition hover:border-bronze/60 hover:text-bronze-bright">✕</button>
        </div>
        {item.artist && (
          <button type="button" onClick={() => onSearch(item.artist)} className="text-left text-[.92rem] text-bronze/90 transition hover:text-bronze-bright" title={`More by ${item.artist}`}>
            {item.artist}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={item.source} />
          {item.source !== 'scan' && (
            <span className={'rounded-sm px-1.5 py-0.5 font-mono text-[.62rem] ' + (item.isPublicDomain ? 'bg-bronze/15 text-bronze' : 'border border-line text-muted')}>
              {item.isPublicDomain ? 'Public domain' : '© rights may apply'}
            </span>
          )}
          {item.lossless && <span className="rounded-sm border border-bronze/40 bg-bronze/10 px-1.5 py-0.5 font-mono text-[.62rem] text-bronze-bright">◆ lossless</span>}
        </div>
        <dl className="space-y-1 text-[.82rem]">
          {item.date && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted/60">Date</dt><dd className="text-ink/85">{item.date}</dd></div>}
          {item.medium && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted/60">Medium</dt><dd className="text-ink/85">{item.medium}</dd></div>}
          {item.culture && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted/60">Origin / genre</dt><dd className="text-ink/85">{item.culture}</dd></div>}
          {item.dimensions && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted/60">Dimensions</dt><dd className="text-ink/85">{item.dimensions}</dd></div>}
          {resolution && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted/60">Resolution</dt><dd className="font-mono text-ink/85">{resolution}</dd></div>}
          <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted/60">Format</dt><dd className="font-mono uppercase text-ink/85">{item.format}</dd></div>
        </dl>
        {item.description && <p className="text-[.86rem] leading-relaxed text-muted">{item.description}</p>}
        {item.creditLine && <p className="text-[.76rem] italic leading-snug text-muted/60">{item.creditLine}</p>}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {item.video ? (
            <>
              <span className="font-mono text-[.72rem] text-muted/60">⬇ {item.format === 'm4a' ? 'audio' : 'video'}</span>
              {item.video.variants.map((v) => item.video!.direct ? (
                // cobalt tunnel already serves Content-Disposition: attachment
                <a
                  key={v.url}
                  href={v.url}
                  download={safeName(item.title || 'video', item.artist, item.format === 'm4a' ? 'm4a' : 'mp4')}
                  className="rounded border border-bronze/45 bg-bronze/10 px-3 py-1.5 font-mono text-[.74rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20"
                >
                  {v.label}
                </a>
              ) : (
                <button
                  key={v.url}
                  type="button"
                  onClick={() => downloadViaProxy(v.url, safeName(item.title || 'video', item.artist, 'mp4'))}
                  className="rounded border border-bronze/45 bg-bronze/10 px-3 py-1.5 font-mono text-[.74rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20"
                >
                  {v.label}
                </button>
              ))}
            </>
          ) : item.deepzoom ? (
            <button
              type="button"
              onClick={runStitch}
              disabled={stitch?.phase === 'busy'}
              title="Download the full image by stitching every tile in your browser"
              className="rounded border border-bronze/45 bg-bronze/10 px-3 py-1.5 font-mono text-[.74rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {stitch?.phase === 'busy'
                ? `Stitching… ${stitch.total ? Math.round((stitch.done / stitch.total) * 100) : 0}%`
                : '⬇ Download full resolution'}
            </button>
          ) : (
            <DownloadMenu fullUrl={item.fullUrl} title={item.title} artist={item.artist} />
          )}
          {analyzeEnabled && !item.video && (
            <button type="button" onClick={() => onAnalyze(item)} className="rounded border border-bronze/40 bg-bronze/[.07] px-3 py-1.5 font-mono text-[.74rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/15">✦ Analyse</button>
          )}
          <button type="button" onClick={() => onShare(item.id)} title="Copy a shareable link" className="rounded border border-line px-2.5 py-1.5 font-mono text-[.78rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">⧉</button>
          {onFindSource && (
            <button type="button" onClick={() => onFindSource(item.fullUrl)} title="Reverse-image search: find the source / a higher-res original" className="rounded border border-line px-2.5 py-1.5 font-mono text-[.78rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">🔍</button>
          )}
        </div>
        {item.deepzoom && (() => {
          const lvl = stitchLevel(item.deepzoom);
          const { w, h } = levelDimensions(item.deepzoom, lvl);
          const capped = w < item.deepzoom.width || h < item.deepzoom.height;
          return (
            <p className="font-mono text-[.72rem] leading-snug text-muted/70">
              {stitch?.phase === 'error' ? (
                <span className="text-bronze">⊘ {stitch.msg}</span>
              ) : stitch?.phase === 'done' ? (
                <span className="text-bronze">✓ stitched {stitch.w}×{stitch.h} — saved</span>
              ) : (
                <>Stitches to {w.toLocaleString()}×{h.toLocaleString()} px in your browser{capped && ' (browser canvas cap — use the Harpe CLI for the full pyramid)'}.</>
              )}
            </p>
          );
        })()}
        {item.sourceUrl && (
          <a href={item.sourceUrl} target="_blank" rel="noopener" className="font-mono text-[.76rem] text-bronze/80 transition hover:text-bronze-bright">↗ view at source</a>
        )}

        {similar.length > 0 && (
          <div className="mt-2 border-t border-line pt-3">
            <p className="mb-2 font-mono text-[.7rem] uppercase tracking-wider text-muted/60">More like this</p>
            <div className="grid grid-cols-3 gap-2">
              {similar.map((s) => {
                const i = items.indexOf(s);
                return (
                  <button key={s.id} type="button" onClick={() => i >= 0 && onIndex(i)} className="overflow-hidden rounded ring-1 ring-line/40 transition hover:ring-bronze/60" title={s.title}>
                    <img src={displaySrc(s.thumbUrl)} alt={s.title} loading="lazy" className="aspect-square w-full object-cover" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}

// Render the educational analysis: bold the "Section:" labels, paragraph spacing,
// and turn URLs (e.g. the "Learn more:" Wikipedia link) into clickable links.
function AnalysisBody({ text }: { text: string }) {
  const linkify = (str: string) =>
    str.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
      /^https?:\/\//.test(part)
        ? <a key={i} href={part} target="_blank" rel="noopener" className="break-all text-bronze hover:text-bronze-bright">{part}</a>
        : <span key={i}>{part}</span>,
    );
  // Group lines into paragraphs: a "Label:" line starts a new one; wrapped
  // continuation lines append. So each section ("The Subject", "Facts", "Learn
  // more") becomes its own paragraph with a bold label, however the model spaced it.
  const LABEL = /^([A-Z][A-Za-z ]{1,28}):\s*(.*)$/;
  const paras: Array<{ label?: string; body: string }> = [];
  for (const raw of text.trim().split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LABEL.exec(line);
    if (m) paras.push({ label: m[1], body: m[2] });
    else if (paras.length) paras[paras.length - 1].body += ' ' + line;
    else paras.push({ body: line });
  }
  return (
    <div className="space-y-3 text-[.9rem] leading-relaxed text-ink/90">
      {paras.map((p, i) => (
        <p key={i}>{p.label && <strong className="text-bronze-bright">{p.label} </strong>}{linkify(p.body)}</p>
      ))}
    </div>
  );
}

// ─── Finder ────────────────────────────────────────────────────────────────────

export default function Finder() {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState('');

  // scan state
  const [pageUrl, setPageUrl] = useState('');
  const [images, setImages] = useState<ScanImage[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dlMap, setDlMap] = useState<Map<number, DlStatus>>(new Map());
  const [dlBusy, setDlBusy] = useState(false);
  const [dlDone, setDlDone] = useState(false);
  // a gigapixel/zoomable image detected on a scanned page (shown alongside images)
  const [scanDeepzoom, setScanDeepzoom] = useState<DeepZoomDescriptor | null>(null);

  // art state
  const [artItems, setArtItems] = useState<ArtItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [losslessOnly, setLosslessOnly] = useState(false);
  const [pdOnly, setPdOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());
  const [mediumFilter, setMediumFilter] = useState<Set<string>>(new Set());
  const [minRes, setMinRes] = useState(0);            // 0 | 1920 | 3840
  const [yearMin, setYearMin] = useState('');
  const [yearMax, setYearMax] = useState('');
  const [query, setQuery] = useState('');
  const [streaming, setStreaming] = useState(false);   // SSE search in progress
  const [shown, setShown] = useState(SHOWN_STEP);       // infinite-scroll window
  const streamCancelRef = useRef<null | (() => void)>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // shared lightbox (index into the currently-visible list)
  // The open detail is tracked by item ID (not index) so streaming re-ordering
  // doesn't swap which artwork is shown — the index is derived from the id.
  const [detailId, setDetailId] = useState<string | null>(null);

  // reverse-image search (SauceNAO) — scan mode
  const [sauceEnabled, setSauceEnabled] = useState(false);
  const [sauce, setSauce] = useState<
    | null
    | { phase: 'loading' | 'done' | 'error'; imageUrl: string; results?: SauceResult[]; message?: string }
  >(null);

  // cross-source synthesis ("mega-analysis")
  const [analyzeEnabled, setAnalyzeEnabled] = useState(false);
  const [analysis, setAnalysis] = useState<
    | null
    | { phase: 'loading' | 'done' | 'error'; title: string; text?: string; contributors?: string[]; cached?: boolean; message?: string; wikipedia?: { title: string; url: string } }
  >(null);

  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setDetailId(null);
    setMode('loading');
    setError('');

    // X / Twitter post URL → resolve its video(s) + photos (public syndication API)
    const xm = isURL(q) ? X_STATUS_RE.exec(q) : null;
    if (xm) {
      try {
        const res = await fetch(`/api/x?id=${xm[1]}`);
        const json = await res.json();
        if (!res.ok) { setError(json.error ?? `Error ${res.status}`); setMode('error'); return; }
        const items = xMediaToItems(json, q);
        if (items.length === 0) { setMode('empty'); return; }
        setArtItems(items); setWarnings([]); setQuery(q); setStreaming(false);
        setSourceFilter(new Set()); setPdOnly(false); setLosslessOnly(false);
        setMediumFilter(new Set()); setMinRes(0); setYearMin(''); setYearMax('');
        setMode('art');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error'); setMode('error');
      }
      return;
    }

    // IIIF URL → resolve to a single art result
    if (isURL(q) && IIIF_MANIFEST_RE.test(q)) {
      const result = await resolveIIIF(q);
      if (result) {
        setArtItems([result]); setWarnings([]); setQuery(q); setMode('art');
      } else {
        setError('Could not resolve a downloadable image from that IIIF URL. Try the Harpe CLI for full tile-stitching support.');
        setMode('error');
      }
      return;
    }

    // A DeepZoom (.dzi) / Zoomify (ImageProperties.xml) descriptor pasted directly
    // → resolve to a deep-zoom item (our own in-browser viewer + full-res stitch).
    if (isURL(q) && DEEPZOOM_DESC_RE.test(q)) {
      try {
        const res = await fetch(`/api/deepzoom?url=${encodeURIComponent(q)}`);
        const json: { ok?: boolean; descriptor?: DeepZoomDescriptor; message?: string } = await res.json();
        if (json.ok && json.descriptor) {
          setArtItems([deepzoomItem(json.descriptor, q)]); setWarnings([]); setQuery(q);
          setStreaming(false); setSourceFilter(new Set()); setPdOnly(false); setLosslessOnly(false);
          setMode('art'); return;
        }
        setError(json.message || 'Could not read that zoomable-image descriptor.'); setMode('error');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error'); setMode('error');
      }
      return;
    }

    // A direct image URL → show THAT image (the whole point of pasting one). Thumb
    // and preview go through our resize proxy so a gigapixel original isn't loaded
    // just to display; the full-res original stays the download.
    if (isURL(q) && IMAGE_URL_RE.test(q)) {
      const fmt = fmtFromUrl(q);
      const enc = encodeURIComponent(q);
      const it: ArtItem = {
        id: q,
        title: decodeURIComponent((q.split('/').pop() || 'image').split(/[?#]/)[0]),
        artist: '',
        thumbUrl: `/api/fetch?url=${enc}&w=1024`,
        previewUrl: `/api/fetch?url=${enc}&w=2560`,
        fullUrl: q,
        format: fmt,
        lossless: LOSSLESS_FORMATS.has(fmt),
        downloads: [{ label: 'Original', url: q, format: fmt, lossless: LOSSLESS_FORMATS.has(fmt) }],
        source: 'scan',
        isPublicDomain: true,
        sourceUrl: q,
      };
      setArtItems([it]); setWarnings([]); setQuery(q); setStreaming(false);
      setSourceFilter(new Set()); setPdOnly(false); setLosslessOnly(false);
      setMode('art');
      return;
    }

    // A cobalt-supported media host (YouTube/IG/TikTok/Reddit/…) → resolve via the
    // self-hosted cobalt backend (/api/grab). 501 → not configured: tell the user.
    if (isURL(q) && MEDIA_HOST_RE.test((() => { try { return new URL(q).hostname; } catch { return ''; } })())) {
      try {
        const res = await fetch(`/api/grab?url=${encodeURIComponent(q)}`);
        const json = await res.json();
        if (res.ok && Array.isArray(json.media)) {
          const items = cobaltMediaToItems(json, q);
          if (items.length) {
            setArtItems(items); setWarnings([]); setQuery(q); setStreaming(false);
            setSourceFilter(new Set()); setPdOnly(false); setLosslessOnly(false);
            setMediumFilter(new Set()); setMinRes(0); setYearMin(''); setYearMax('');
            setMode('art'); return;
          }
        }
        setError(json.error ?? `Could not grab media (${res.status}).`); setMode('error'); return;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error'); setMode('error'); return;
      }
    }

    // Any other URL → scan the page for images
    if (isURL(q)) {
      setImages([]); setSelected(new Set()); setDlMap(new Map()); setDlBusy(false); setDlDone(false);
      setScanDeepzoom(null); setPageUrl(q); setQuery(q);
      try {
        const res = await fetch(`/api/scan?url=${encodeURIComponent(q)}`);
        const json: { images?: ImageCandidate[]; error?: string; sauceEnabled?: boolean; deepzoom?: DeepZoomDescriptor | null } = await res.json();
        if (!res.ok) { setError(json.error ?? `Server error ${res.status}`); setMode('error'); return; }
        setSauceEnabled(Boolean(json.sauceEnabled));
        const candidates = json.images ?? [];
        // A zoomable/gigapixel image was detected on the page.
        if (json.deepzoom) {
          // No flat images either → it IS a deep-zoom viewer (GA&C-style). Open ours.
          if (candidates.length === 0) {
            setArtItems([deepzoomItem(json.deepzoom, q)]); setWarnings([]);
            setStreaming(false); setSourceFilter(new Set()); setPdOnly(false); setLosslessOnly(false);
            setMode('art'); return;
          }
          // Has flat images too → list them, but offer the gigapixel viewer up top.
          setScanDeepzoom(json.deepzoom);
        }
        if (candidates.length === 0) { setMode('empty'); return; }
        setImages(candidates.map((c) => ({ ...c, naturalWidth: -1, loaded: false })));
        setMode('scan');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error'); setMode('error');
      }
      return;
    }

    // Plain text → museum search, STREAMED per-source (with /api/art fallback).
    streamCancelRef.current?.();         // abort any in-flight stream
    setQuery(q); setArtItems([]); setWarnings([]); setShown(SHOWN_STEP); setStreaming(true);
    setSourceFilter(new Set()); setPdOnly(false); setLosslessOnly(false); setDetailId(null);
    setMediumFilter(new Set()); setMinRes(0); setYearMin(''); setYearMax('');
    const acc: ArtItem[] = [];
    let gotBatch = false;
    const cancel = streamArt(q, {
      onBatch: (_source, items) => {
        gotBatch = true;
        for (const it of items) acc.push(normalizeArt(it));
        setArtItems(rankArt(acc, q));
        setMode('art');
      },
      onError: (source, err) => { setWarnings((w) => [...w, `${source}: ${err}`]); },
      onDone: ({ analyzeEnabled }) => {
        setStreaming(false);
        streamCancelRef.current = null;
        setAnalyzeEnabled(analyzeEnabled);
        if (!gotBatch) { fallbackArt(q); }       // SSE produced nothing → REST fallback
        else if (acc.length === 0) setMode('empty');
      },
    });
    streamCancelRef.current = cancel;
  }, []);

  // Non-streaming fallback (used if the SSE stream yields nothing — e.g. a proxy
  // that buffers event-streams).
  const fallbackArt = useCallback(async (q: string) => {
    try {
      const res = await fetch(`/api/art?q=${encodeURIComponent(q)}`);
      const json: { items?: unknown[]; warnings?: string[]; error?: string; analyzeEnabled?: boolean } = await res.json();
      if (!res.ok) { setError(json.error ?? `Server error ${res.status}`); setMode('error'); return; }
      setAnalyzeEnabled(Boolean(json.analyzeEnabled));
      setWarnings(Array.isArray(json.warnings) ? json.warnings : []);
      const items = (json.items ?? []).map(normalizeArt);
      if (items.length === 0) { setMode('empty'); return; }
      setArtItems(rankArt(items, q)); setMode('art');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error'); setMode('error');
    }
  }, []);

  const findSource = useCallback(async (imageUrl: string) => {
    setSauce({ phase: 'loading', imageUrl });
    try {
      const res = await fetch(`/api/sauce?url=${encodeURIComponent(imageUrl)}`);
      const json = await res.json();
      if (!res.ok) { setSauce({ phase: 'error', imageUrl, message: json.error ?? `Error ${res.status}` }); return; }
      setSauce({ phase: 'done', imageUrl, results: Array.isArray(json.results) ? json.results : [] });
    } catch (e) {
      setSauce({ phase: 'error', imageUrl, message: e instanceof Error ? e.message : 'Network error' });
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); run(input); };
  // Run a search from a picked suggestion / discovery chip (reflect it in the box).
  const runQuery = useCallback((q: string) => { setInput(q); run(q); }, [run]);

  // ── scan helpers ──
  const handleLoad = useCallback((idx: number, nw: number) => {
    setImages((prev) => { const n = [...prev]; n[idx] = { ...n[idx], naturalWidth: nw, loaded: true }; return n; });
  }, []);
  const handleError = useCallback((idx: number) => {
    setImages((prev) => { const n = [...prev]; n[idx] = { ...n[idx], naturalWidth: -1, loaded: true }; return n; });
  }, []);

  const visibleScan: Array<[ScanImage, number]> = useMemo(
    () =>
      images
        .map((img, i) => [img, i] as [ScanImage, number])
        .filter(([img]) => !img.loaded || img.naturalWidth >= MIN_WIDTH)
        .sort(([a], [b]) => {
          const wa = a.naturalWidth > 0 ? a.naturalWidth : 0;
          const wb = b.naturalWidth > 0 ? b.naturalWidth : 0;
          if (wa > 0 && wb > 0) return wb - wa;
          if (wa > 0) return -1;
          if (wb > 0) return 1;
          return 0;
        }),
    [images],
  );

  // Scanned-page images mapped into the SAME ArtItem shape the museum grid uses,
  // so links and text-search render with the identical cards + detail view.
  const scanAsArt = useMemo<ArtItem[]>(
    () => visibleScan.map(([img]) => {
      const fmt = fmtFromUrl(img.url);
      return {
        id: img.url,
        title: img.name,
        artist: '',
        thumbUrl: img.url,
        previewUrl: img.url,
        fullUrl: img.url,
        width: img.naturalWidth > 0 ? img.naturalWidth : undefined,
        format: fmt,
        lossless: LOSSLESS_FORMATS.has(fmt),
        downloads: [{ label: 'Download', url: img.url, format: fmt, lossless: LOSSLESS_FORMATS.has(fmt) }],
        source: 'scan',
        isPublicDomain: true,
        sourceUrl: pageUrl || undefined,
      };
    }),
    [visibleScan, pageUrl],
  );

  const toggleSelect = useCallback((idx: number) => {
    setSelected((prev) => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  }, []);
  const selectAll = () => setSelected(new Set(visibleScan.map(([, i]) => i)));
  const clearAll = () => setSelected(new Set());

  const downloadSelected = async () => {
    if (selected.size === 0 || dlBusy) return;
    setDlBusy(true); setDlDone(false);
    const queue = [...selected].map((idx) => ({ idx, item: images[idx] })).filter(({ item }) => item);
    const map = new Map<number, DlStatus>(queue.map(({ idx }) => [idx, 'downloading']));
    setDlMap(new Map(map));
    for (const { idx, item } of queue) {
      try {
        await downloadViaProxy(item.url, item.name, pageUrl || undefined);
        map.set(idx, 'done'); setDlMap(new Map(map));
      } catch {
        map.set(idx, 'error'); setDlMap(new Map(map));
      }
    }
    setDlBusy(false); setDlDone(true);
    setTimeout(() => { setDlDone(false); setDlMap(new Map()); }, 4000);
  };

  // ── art helpers ──
  const visibleArt = useMemo(() => {
    let r = artItems;
    if (losslessOnly) r = r.filter((i) => i.lossless);
    if (pdOnly) r = r.filter((i) => i.isPublicDomain);
    if (sourceFilter.size) r = r.filter((i) => sourceFilter.has(i.source));
    if (mediumFilter.size) r = r.filter((i) => mediumFilter.has(mediumCategory(i.medium)));
    if (minRes) r = r.filter((i) => { const le = Math.max(i.width || 0, i.height || 0); return le === 0 || le >= minRes; });
    const ymin = yearMin === '' ? null : Number(yearMin);
    const ymax = yearMax === '' ? null : Number(yearMax);
    if (ymin != null && !Number.isNaN(ymin)) r = r.filter((i) => { const y = yearOf(i.date); return y == null || y >= ymin; });
    if (ymax != null && !Number.isNaN(ymax)) r = r.filter((i) => { const y = yearOf(i.date); return y == null || y <= ymax; });
    return r;
  }, [artItems, losslessOnly, pdOnly, sourceFilter, mediumFilter, minRes, yearMin, yearMax]);
  const mediumCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of artItems) { const c = mediumCategory(it.medium); m.set(c, (m.get(c) ?? 0) + 1); }
    const order = ['painting', 'print', 'drawing', 'photo', 'sculpture', 'textile', 'other'];
    return [...m.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [artItems]);
  const toggleMedium = useCallback((c: string) => {
    setMediumFilter((prev) => { const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); return n; });
  }, []);
  const losslessCount = useMemo(() => artItems.filter((i) => i.lossless).length, [artItems]);
  const pdCount = useMemo(() => artItems.filter((i) => i.isPublicDomain).length, [artItems]);
  // sources present in the current results, with counts, ordered by SOURCE_ORDER
  const sourceCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of artItems) m.set(it.source, (m.get(it.source) ?? 0) + 1);
    return [...m.entries()].sort(
      (a, b) => (SOURCE_ORDER[a[0]] ?? 99) - (SOURCE_ORDER[b[0]] ?? 99),
    );
  }, [artItems]);
  const toggleSource = useCallback((s: string) => {
    setSourceFilter((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  }, []);

  // group items that describe the same work (across sources) for synthesis
  const siblingsByKey = useMemo(() => {
    const m = new Map<string, ArtItem[]>();
    for (const it of artItems) {
      const k = workKey(it);
      (m.get(k) ?? m.set(k, []).get(k)!).push(it);
    }
    return m;
  }, [artItems]);

  // The active list for the shared detail viewer: scanned-page images or museum art.
  const detailItems = mode === 'scan' ? scanAsArt : visibleArt;
  const detailIndex = detailId ? detailItems.findIndex((it) => it.id === detailId) : -1;
  const openDetailAt = useCallback((i: number) => setDetailId(detailItems[i]?.id ?? null), [detailItems]);

  // Open a detected gigapixel image in our deep-zoom viewer (from a scanned page).
  const openDeepzoom = useCallback((d: DeepZoomDescriptor) => {
    const it = deepzoomItem(d, pageUrl || undefined);
    setArtItems([it]); setWarnings([]); setStreaming(false);
    setSourceFilter(new Set()); setPdOnly(false); setLosslessOnly(false);
    setMediumFilter(new Set()); setMinRes(0); setYearMin(''); setYearMax('');
    setMode('art'); setDetailId(it.id);
  }, [pageUrl]);

  const analyzeWork = useCallback(async (item: ArtItem) => {
    const group = siblingsByKey.get(workKey(item)) ?? [item];
    setAnalysis({ phase: 'loading', title: item.title });
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: item.title.replace(/\s*\([^)]*\)\s*$/, ''),
          artist: item.artist,
          items: group.map((g) => ({
            source: g.source, date: g.date, medium: g.medium, culture: g.culture,
            creditLine: g.creditLine, description: g.description, sourceUrl: g.sourceUrl,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        const rateLimited = /429|rate.?limit|temporarily/i.test(JSON.stringify(json));
        const message = rateLimited
          ? 'The free AI models are busy right now — please try again in a moment.'
          : (json.error ?? `Error ${res.status}`);
        setAnalysis({ phase: 'error', title: item.title, message });
        return;
      }
      setAnalysis({ phase: 'done', title: item.title, text: json.analysis, contributors: json.contributors, cached: json.cached, wikipedia: json.wikipedia });
    } catch (e) {
      setAnalysis({ phase: 'error', title: item.title, message: e instanceof Error ? e.message : 'Network error' });
    }
  }, [siblingsByKey]);

  // ── shareable links (zero extra cost: pure client-side URL state) ──
  // The current search lives in the URL as ?q=<term>; an open slide adds &v=<id>.
  // Opening a shared link just re-runs the same search against the same endpoints,
  // so it costs exactly what a normal search does — nothing extra.
  const [shareMsg, setShareMsg] = useState('');

  const buildShareUrl = useCallback(
    (viewId?: string): string => {
      const term = mode === 'scan' ? pageUrl : query;
      const params = new URLSearchParams();
      if (term) params.set('q', term);
      if (viewId) {
        params.set('v', viewId);
        // Embed preview data so social crawlers get a rich card with no refetch
        // (read by middleware.ts). Only on the shared link, not the address bar.
        const it = detailItems.find((i) => i.id === viewId);
        if (it) {
          params.set('t', it.title);
          // Embed the larger preview as the card image; middleware caps it to a
          // ~1200px JPEG via the proxy, so bigger source = sharper card, no risk.
          const previewSrc = it.previewUrl || it.thumbUrl;
          if (previewSrc) params.set('img', previewSrc);
          const d = [it.artist, it.date, it.medium].filter(Boolean).join(' · ');
          if (d) params.set('d', d);
        }
      }
      return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    },
    [mode, pageUrl, query, detailItems],
  );

  const copyShare = useCallback(
    async (viewId?: string) => {
      const url = buildShareUrl(viewId);
      try {
        await navigator.clipboard.writeText(url);
        setShareMsg('Link copied ✓');
      } catch {
        setShareMsg('Copy this link: ' + url);
      }
      setTimeout(() => setShareMsg(''), 2600);
    },
    [buildShareUrl],
  );

  // Hydrate from the URL on first load: ?q= runs the search, ?v= opens that item.
  // detailId persists; the detailIndex memo opens it as soon as it streams in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const v = params.get('v');
    if (q) { setInput(q); run(q); }
    if (v) setDetailId(v); // AFTER run() — run() clears detailId, so set it last
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the address bar in sync (replaceState → no history spam during streaming).
  // When a work is open, embed its preview data (t/img/d via buildShareUrl) so a
  // copied address-bar link gets a rich link preview with NO server-side refetch
  // — Vercel edge middleware can't reliably fetch its own /api/art, so relying on
  // that left address-bar shares imageless. Embedding makes every copy work.
  useEffect(() => {
    if (mode !== 'art' && mode !== 'scan') return;
    const term = mode === 'scan' ? pageUrl : query;
    if (!term) return;
    const hasDetail = !!detailId && detailIndex >= 0;
    window.history.replaceState(null, '', buildShareUrl(hasDetail ? detailId : undefined));
  }, [mode, query, pageUrl, detailId, detailIndex, buildShareUrl]);

  // Infinite scroll: reveal more cards as the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) setShown((s) => s + SHOWN_STEP); },
      { rootMargin: '600px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [mode, visibleArt.length]);

  const URL_EXAMPLE = 'https://en.wikipedia.org/wiki/Perseus';

  return (
    <section id="finder" aria-label="Find and download images" className="w-full">
      {/* the one search box */}
      <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-[680px] flex-col gap-2 sm:flex-row">
        <label htmlFor={inputId} className="sr-only">Paste a link, or search for art</label>
        <SearchSuggest
          value={input}
          onChange={setInput}
          onPick={runQuery}
          enabled={!isURL(input)}
          inputId={inputId}
          inputRef={inputRef}
          placeholder="Paste a link, or search for art…"
          className="w-full rounded-lg border border-line bg-[rgba(14,10,7,.82)] px-4 py-3 font-mono text-[.92rem] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.03)] outline-none transition placeholder:text-muted/55 focus:border-bronze/70 focus:ring-2 focus:ring-bronze/25"
        />
        <button
          type="submit"
          disabled={mode === 'loading' || !input.trim()}
          className="flex items-center justify-center gap-2 rounded-lg border border-bronze/50 bg-bronze/15 px-6 py-3 font-mono text-[.92rem] font-medium text-bronze-bright transition hover:border-bronze hover:bg-bronze/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {mode === 'loading' && <Spinner small />}
          {input.trim() && isURL(input) ? 'Find images' : 'Search'}
        </button>
      </form>

      {/* one-line explainer */}
      <p className="mx-auto mt-3 max-w-[600px] text-center text-[.82rem] text-muted">
        Paste a page or gallery <strong className="font-semibold text-ink/80">URL</strong> to grab its
        images — or type an <strong className="font-semibold text-ink/80">artwork or artist</strong> to
        search the world's museums.
      </p>

      {/* idle state → curated discovery (artists / movements / themes) */}
      {mode === 'idle' && (
        <>
          {!isURL(input) && (
            <div className="mt-7">
              <Discover onPick={runQuery} />
            </div>
          )}
          <p className="mt-7 text-center text-[.78rem] text-muted/70">
            …or paste a page / gallery URL to grab its images —{' '}
            <button
              type="button"
              onClick={() => runQuery(URL_EXAMPLE)}
              className="text-bronze underline-offset-2 transition hover:text-bronze-bright hover:underline"
            >
              try one ↗
            </button>
          </p>
          <p className="mt-6 text-center font-mono text-[.68rem] tracking-[0.04em] text-muted/55">
            millions of works across 15 open collections — the Met · Art Institute of Chicago · Cleveland · V&amp;A ·
            Wellcome · Harvard · Smithsonian · Library of Congress · SMK · Nasjonalmuseet · Europeana · Wikidata · DigitalNZ · WikiArt · Wikimedia Commons
          </p>
        </>
      )}

      {/* ── results ── */}
      <div className="mt-10">
        {mode === 'loading' && (
          <div aria-live="polite" aria-label="Searching" className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
            {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {mode === 'error' && (
          <div role="alert" className="mx-auto max-w-[540px] rounded-xl border border-line bg-[rgba(16,11,8,.6)] p-6 text-center">
            <span className="mb-2 block font-mono text-2xl text-bronze">⊘</span>
            <p className="text-[.9rem] text-muted">{error}</p>
          </div>
        )}

        {mode === 'empty' && (
          <div className="mx-auto max-w-[560px] rounded-xl border border-line bg-[rgba(16,11,8,.6)] p-6 text-center">
            <span className="mb-2 block font-mono text-2xl text-bronze">◈</span>
            <p className="text-[.9rem] text-muted">
              {isURL(query || input)
                ? "No images found in that page's static HTML."
                : `No results for “${query}” in the open-access collections.`}
            </p>
            <p className="mt-3 font-mono text-[.78rem] text-muted/60">
              JS-rendered or login-walled pages, and video, need the{' '}
              <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">Harpe CLI</a>{' '}
              or browser extension.
            </p>
            {isURL(query || input) && (
              <p className="mt-3 font-mono text-[.78rem] text-muted/70">
                {/(^|\.)artsandculture\.google\.com/i.test(query || input)
                  ? <>Google Arts &amp; Culture uses proprietary signed tiles that rotate — those need the Harpe CLI (dezoomify-rs). Zoomify, DeepZoom &amp; IIIF viewers stitch right here in the browser.</>
                  : <>Zoomable / gigapixel images (Zoomify, DeepZoom, IIIF) are detected and opened in the deep-zoom viewer automatically — none was found here.</>}
              </p>
            )}
          </div>
        )}

        {/* SCAN results — SAME full-width masonry + detail viewer as museum search */}
        {mode === 'scan' && (
          <div aria-live="polite" className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen max-w-[100vw] overflow-x-clip px-4 sm:px-6 lg:px-10">
            <div className="mb-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
              <p className="font-mono text-[.78rem] text-muted/70">
                {visibleScan.length} image{visibleScan.length !== 1 ? 's' : ''}
                {selected.size > 0 && <span className="ml-2 text-bronze">· {selected.size} selected</span>}
              </p>
              <button type="button" onClick={selectAll} className="rounded-full border border-line px-3 py-1 font-mono text-[.72rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">Select all</button>
              <button type="button" onClick={clearAll} className="rounded-full border border-line px-3 py-1 font-mono text-[.72rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">Clear</button>
              <button type="button" onClick={() => copyShare()} title="Copy a shareable link to these results" className="rounded-full border border-line px-3 py-1 font-mono text-[.72rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">⧉ share</button>
              <button
                type="button"
                onClick={downloadSelected}
                disabled={selected.size === 0 || dlBusy}
                className="flex items-center gap-2 rounded-full border border-bronze/45 bg-bronze/10 px-4 py-1 font-mono text-[.72rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {dlBusy && <Spinner small />}
                {dlDone ? 'Done ✓' : `Download${selected.size > 0 ? ` ${selected.size}` : ''}`}
              </button>
              {scanDeepzoom && (
                <button
                  type="button"
                  onClick={() => openDeepzoom(scanDeepzoom)}
                  title="A gigapixel / zoomable image was detected on this page"
                  className="flex items-center gap-2 rounded-full border border-bronze/45 bg-bronze/10 px-4 py-1 font-mono text-[.72rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20"
                >
                  ⊕ Open gigapixel viewer
                </button>
              )}
            </div>

            <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 2xl:columns-5">
              {visibleScan.map(([, originalIdx], i) => (
                <ArtCard
                  key={originalIdx}
                  item={scanAsArt[i]}
                  onOpen={() => openDetailAt(i)}
                  selected={selected.has(originalIdx)}
                  onToggleSelect={() => toggleSelect(originalIdx)}
                  dlStatus={dlMap.get(originalIdx)}
                  onImgLoad={(w) => handleLoad(originalIdx, w)}
                  onImgError={() => handleError(originalIdx)}
                />
              ))}
            </div>

            <div className="mx-auto mt-10 max-w-[680px] rounded-xl border border-line bg-[rgba(14,10,7,.55)] px-5 py-4">
              <p className="font-mono text-[.75rem] leading-relaxed text-muted/80">
                <span className="font-semibold text-muted">Works on:</span> static pages, blogs, galleries,
                museum sites, Wikipedia, news, and <span className="text-bronze/90">X / Twitter video posts</span>.{'  '}
                <span className="font-semibold text-muted">Needs the CLI/extension:</span> Instagram, YouTube and
                other login-walled sites — a server can't see your session.
              </p>
            </div>
          </div>
        )}

        {/* ART results — break out of the page's narrow column to a full-width wall */}
        {mode === 'art' && (
          <div aria-live="polite" className="relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen max-w-[100vw] overflow-x-clip px-4 sm:px-6 lg:px-10">
            {warnings.length > 0 && (
              <p className="mb-4 text-center font-mono text-[.75rem] text-amber/80">
                Partial results — some sources failed: {warnings.join(' · ')}
              </p>
            )}
            {(() => {
              const chip = (active: boolean) =>
                'rounded-full border px-3 py-1 font-mono text-[.72rem] transition disabled:cursor-not-allowed disabled:opacity-40 ' +
                (active
                  ? 'border-bronze/60 bg-bronze/15 text-bronze-bright'
                  : 'border-line text-muted hover:border-bronze/60 hover:text-bronze');
              const hasFilters = losslessOnly || pdOnly || sourceFilter.size > 0 || mediumFilter.size > 0 || minRes > 0 || yearMin !== '' || yearMax !== '';
              const clearFilters = () => { setLosslessOnly(false); setPdOnly(false); setSourceFilter(new Set()); setMediumFilter(new Set()); setMinRes(0); setYearMin(''); setYearMax(''); };
              const MED_LABEL: Record<string, string> = { painting: 'Paintings', print: 'Prints', drawing: 'Drawings', photo: 'Photos', sculpture: 'Sculpture', textile: 'Textiles', other: 'Other' };
              return (
                <>
                  <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
                    <p className="font-mono text-[.78rem] text-muted/70">
                      {visibleArt.length} work{visibleArt.length !== 1 ? 's' : ''}
                      {visibleArt.length !== artItems.length && ` of ${artItems.length}`}
                      {streaming && <span className="ml-2 text-bronze">· searching…</span>}
                    </p>
                    <button type="button" onClick={() => setPdOnly((v) => !v)} disabled={pdCount === 0} aria-pressed={pdOnly} className={chip(pdOnly)}>
                      {pdOnly ? '✓ public domain' : `public domain (${pdCount})`}
                    </button>
                    <button type="button" onClick={() => setLosslessOnly((v) => !v)} disabled={losslessCount === 0} aria-pressed={losslessOnly} className={chip(losslessOnly)}>
                      {losslessOnly ? '◆ lossless ✓' : `◆ lossless (${losslessCount})`}
                    </button>
                    <button type="button" onClick={() => copyShare()} title="Copy a shareable link to this search" className={chip(false)}>
                      ⧉ share
                    </button>
                    {hasFilters && (
                      <button type="button" onClick={clearFilters} className="font-mono text-[.72rem] text-bronze/80 underline-offset-2 hover:text-bronze-bright hover:underline">
                        clear filters
                      </button>
                    )}
                  </div>

                  {/* type + resolution + date */}
                  <div className="mb-2 flex flex-wrap items-center justify-center gap-1.5">
                    {mediumCounts.filter(([, n]) => n > 0).map(([c, n]) => (
                      <button key={c} type="button" onClick={() => toggleMedium(c)} aria-pressed={mediumFilter.has(c)} className={chip(mediumFilter.has(c))}>
                        {MED_LABEL[c] ?? c} <span className="opacity-50">{n}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mb-5 flex flex-wrap items-center justify-center gap-1.5 font-mono text-[.72rem]">
                    <span className="text-muted/50">res</span>
                    {([[0, 'any'], [1920, '≥1080p'], [3840, '≥4K']] as [number, string][]).map(([r, lbl]) => (
                      <button key={r} type="button" onClick={() => setMinRes(r)} aria-pressed={minRes === r} className={chip(minRes === r)}>{lbl}</button>
                    ))}
                    <span className="ml-2 text-muted/50">years</span>
                    <input type="number" inputMode="numeric" value={yearMin} onChange={(e) => setYearMin(e.target.value)} placeholder="from" className="w-16 rounded-full border border-line bg-transparent px-2 py-1 text-center text-muted outline-none focus:border-bronze/60" />
                    <span className="text-muted/40">–</span>
                    <input type="number" inputMode="numeric" value={yearMax} onChange={(e) => setYearMax(e.target.value)} placeholder="to" className="w-16 rounded-full border border-line bg-transparent px-2 py-1 text-center text-muted outline-none focus:border-bronze/60" />
                  </div>

                  {sourceCounts.length > 1 && (
                    <div className="mb-5 flex flex-wrap items-center justify-center gap-1.5">
                      {sourceCounts.map(([s, n]) => (
                        <button key={s} type="button" onClick={() => toggleSource(s)} aria-pressed={sourceFilter.has(s)} className={chip(sourceFilter.has(s))}>
                          {SOURCE_LABELS[s] ?? s} <span className="opacity-50">{n}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {visibleArt.length === 0 ? (
                    <p className="text-center font-mono text-[.82rem] text-muted/60">
                      No works match these filters.{' '}
                      <button type="button" onClick={clearFilters} className="text-bronze hover:text-bronze-bright">Clear filters →</button>
                    </p>
                  ) : (
                    <>
                      <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 2xl:columns-5">
                        {visibleArt.slice(0, shown).map((item, i) => (
                          <ArtCard
                            key={item.id}
                            item={item}
                            onOpen={() => openDetailAt(i)}
                          />
                        ))}
                      </div>
                      {shown < visibleArt.length && (
                        <div ref={sentinelRef} className="h-12" aria-hidden />
                      )}
                    </>
                  )}
                </>
              );
            })()}

            <p className="mt-8 text-center font-mono text-[.74rem] text-muted/50">
              Want gigapixel tile-stitching, V&amp;A, Rijksmuseum &amp; 1,800+ other sites?{' '}
              <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">Install Harpe →</a>
            </p>
          </div>
        )}
      </div>

      {/* the one detail viewer — full-size zoom + all metadata + actions, shared by
          museum art AND scanned-page images */}
      <ArtDetail
        items={detailItems}
        index={detailIndex}
        onClose={() => setDetailId(null)}
        onIndex={openDetailAt}
        onAnalyze={analyzeWork}
        onShare={copyShare}
        onSearch={(qq) => { setInput(qq); setDetailId(null); run(qq); }}
        onFindSource={sauceEnabled ? findSource : undefined}
        analyzeEnabled={analyzeEnabled}
      />

      {/* share-link toast */}
      {shareMsg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-lg border border-bronze/50 bg-[rgba(16,11,8,.97)] px-4 py-2 font-mono text-[.8rem] text-bronze-bright shadow-xl"
        >
          {shareMsg}
        </div>
      )}

      {/* reverse-image search (SauceNAO) modal */}
      {sauce && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reverse-image search"
          onClick={() => setSauce(null)}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(8,6,4,.8)] p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-[min(640px,100%)] overflow-y-auto rounded-xl border border-bronze/40 bg-[rgba(16,11,8,.97)] p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <img src={displaySrc(sauce.imageUrl)} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                <div>
                  <span className="block font-mono text-[.7rem] tracking-[0.12em] text-bronze">🔍 SOURCE MATCHES</span>
                  <h3 className="mt-0.5 font-display text-[1.05rem] font-medium text-ink">Where this image appears</h3>
                </div>
              </div>
              <button
                onClick={() => setSauce(null)}
                aria-label="Close"
                className="rounded-md border border-line px-2 py-0.5 font-mono text-muted transition hover:border-bronze/60 hover:text-bronze-bright"
              >✕</button>
            </div>

            {sauce.phase === 'loading' && (
              <p className="flex items-center gap-2 py-6 font-mono text-[.85rem] text-muted"><Spinner /> Searching the web for this image…</p>
            )}
            {sauce.phase === 'error' && (
              <p className="py-4 text-[.88rem] text-amber/90">{sauce.message}</p>
            )}
            {sauce.phase === 'done' && (
              (sauce.results && sauce.results.length > 0) ? (
                <ul className="space-y-2">
                  {sauce.results.map((r, i) => (
                    <li key={i} className="flex items-center gap-3 rounded-lg border border-line p-2.5">
                      {r.thumbnail && <img src={displaySrc(r.thumbnail)} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded object-cover" />}
                      <div className="min-w-0 flex-1">
                        <a href={r.urls[0]} target="_blank" rel="noopener" className="block truncate font-medium text-[.86rem] text-bronze-bright hover:underline">
                          {r.title || r.site || r.urls[0]}
                        </a>
                        {r.author && <p className="truncate text-[.76rem] text-muted">{r.author}</p>}
                        <p className="truncate font-mono text-[.68rem] text-muted/60">{r.site}{r.urls.length > 1 ? ` · +${r.urls.length - 1} more` : ''}</p>
                      </div>
                      <span className="shrink-0 rounded-sm bg-bronze/10 px-1.5 py-0.5 font-mono text-[.66rem] text-bronze">{r.similarity.toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-[.86rem] text-muted">No close matches found for this image.</p>
              )
            )}
            <p className="mt-3 font-mono text-[.64rem] text-muted/50">Matches via SauceNAO — similarity is approximate; verify the source before reuse.</p>
          </div>
        </div>
      )}

      {/* cross-source synthesis modal */}
      {analysis && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Synthesized analysis"
          onClick={() => setAnalysis(null)}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(8,6,4,.8)] p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-[min(620px,100%)] overflow-y-auto rounded-xl border border-bronze/40 bg-[rgba(16,11,8,.97)] p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <span className="block font-mono text-[.7rem] tracking-[0.12em] text-bronze">✦ SYNTHESIZED ACROSS SOURCES</span>
                <h3 className="mt-1 font-display text-[1.1rem] font-medium text-ink">{analysis.title}</h3>
              </div>
              <button
                onClick={() => setAnalysis(null)}
                aria-label="Close"
                className="rounded-md border border-line px-2 py-0.5 font-mono text-muted transition hover:border-bronze/60 hover:text-bronze-bright"
              >✕</button>
            </div>

            {analysis.phase === 'loading' && (
              <p className="flex items-center gap-2 py-6 font-mono text-[.85rem] text-muted"><Spinner /> Merging sources &amp; synthesizing…</p>
            )}
            {analysis.phase === 'error' && (
              <p className="py-4 text-[.88rem] text-amber/90">{analysis.message}</p>
            )}
            {analysis.phase === 'done' && analysis.text && (
              <>
                <AnalysisBody text={analysis.text} />
                {analysis.wikipedia?.url && (
                  <p className="mt-4 border-t border-line pt-3 font-mono text-[.72rem] text-muted/80">
                    📖 Background from Wikipedia:{' '}
                    <a href={analysis.wikipedia.url} target="_blank" rel="noopener" className="text-bronze hover:text-bronze-bright">{analysis.wikipedia.title}</a>
                  </p>
                )}
                {analysis.contributors && analysis.contributors.length > 0 && (
                  <p className="mt-2 font-mono text-[.7rem] text-muted/70">
                    Synthesized from: {analysis.contributors.join(' · ')}
                    {analysis.cached ? ' · cached' : ''}
                  </p>
                )}
                <p className="mt-2 font-mono text-[.66rem] text-muted/50">AI-assisted, grounded in the sources &amp; Wikipedia — may contain errors.</p>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
