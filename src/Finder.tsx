/**
 * Finder — the one search box for the whole site.
 *
 * Type anything:
 *   • a page / gallery URL   → server scans it and lists every image (pick & download)
 *   • a IIIF manifest URL    → resolves the zoomable image
 *   • a title or artist name  → federated museum search (AIC, Met, Cleveland,
 *                                Commons, WikiArt)
 *
 * Both result kinds render in the same grid and open the same MediaLightbox,
 * and every download goes through the same /api/fetch proxy.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import MediaLightbox from './components/MediaLightbox';
import DownloadMenu from './components/DownloadMenu';
import { streamArt } from './lib/useArtStream';
import { fitsScreen } from './lib/resolutions';
import {
  type DownloadVariant,
  type LightboxSlide,
  LOSSLESS_FORMATS,
  displaySrc,
  downloadViaProxy,
  extFor,
  isURL,
  proxyUrl,
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
  source: 'aic' | 'met' | 'cleveland' | 'commons' | 'wikiart' | 'vam' | 'wellcome' | 'smk' | 'nasjonalmuseet' | 'digitalnz' | 'wikidata' | 'europeana' | 'harvard' | 'si' | 'parismusees' | 'moma' | 'nga' | 'mia' | 'loc' | 'nypl' | 'dumps' | 'iiif';
  isPublicDomain: boolean;
  date?: string;
  medium?: string;
  culture?: string;
  creditLine?: string;
  description?: string;
  sourceUrl?: string;
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

// Client-side ranking — mirrors /api/art so streamed results stay relevance-first
// with sources interleaved (round-robin), instead of arrival order.
const STOP = new Set(['the','and','of','to','in','on','by','with','from','for','his','her','its','a','an','at','as']);
const SOURCE_ORDER: Record<string, number> = {
  aic: 0, met: 1, cleveland: 2, vam: 3, wellcome: 4, smk: 5, nasjonalmuseet: 6,
  parismusees: 7, harvard: 8, europeana: 9, si: 10, moma: 11, nga: 12, mia: 13, loc: 14,
  nypl: 15, dumps: 16, wikidata: 17, digitalnz: 18, wikiart: 19, commons: 20,
};
function qTokens(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}
function rankArt(items: ArtItem[], q: string): ArtItem[] {
  const toks = qTokens(q);
  const rel = (it: ArtItem) => {
    const hay = `${it.title} ${it.artist}`.toLowerCase();
    return toks.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };
  const rr = new Map<ArtItem, number>();
  const seen: Record<string, number> = {};
  for (const it of items) { seen[it.source] = (seen[it.source] ?? -1) + 1; rr.set(it, seen[it.source]); }
  return [...items].sort((a, b) => {
    const r = rel(b) - rel(a); if (r) return r;
    const d = (rr.get(a) ?? 0) - (rr.get(b) ?? 0); if (d) return d;
    if (a.isPublicDomain !== b.isPublicDomain) return a.isPublicDomain ? -1 : 1;
    return (SOURCE_ORDER[a.source] ?? 99) - (SOURCE_ORDER[b.source] ?? 99);
  });
}

const IIIF_MANIFEST_RE = /https?:\/\/[^/]+(?:\/[^?#]*)?(?:manifest|info\.json)(?:[?#].*)?$/i;
const IIIF_INFO_RE = /^https?:\/\/.+\/info\.json$/i;

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
  return {
    id: typeof d.id === 'string' ? d.id : String(d.id ?? ''),
    title: typeof d.title === 'string' ? d.title : String(d.title ?? 'Untitled'),
    artist: typeof d.artist === 'string' ? d.artist : String(d.artist ?? ''),
    dimensions: typeof d.dimensions === 'string' && d.dimensions ? d.dimensions : undefined,
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
    date: typeof d.date === 'string' && d.date ? d.date : undefined,
    medium: typeof d.medium === 'string' && d.medium ? d.medium : undefined,
    culture: typeof d.culture === 'string' && d.culture ? d.culture : undefined,
    creditLine: typeof d.creditLine === 'string' && d.creditLine ? d.creditLine : undefined,
    description: typeof d.description === 'string' && d.description ? d.description : undefined,
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

// ─── Scan card (URL mode: select + bulk download, click corner to preview) ─────

function ScanCard({
  item,
  selected,
  onToggle,
  onPreview,
  onFindSource,
  onLoad,
  onError,
  dlStatus,
}: {
  item: ScanImage;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onFindSource?: () => void;
  onLoad: (nw: number) => void;
  onError: () => void;
  dlStatus?: DlStatus;
}) {
  const border = selected
    ? 'border-bronze shadow-[0_4px_24px_-8px_rgba(216,153,33,.35)]'
    : 'border-line hover:border-bronze/60';
  const widthLabel =
    item.naturalWidth > 0 ? `${item.naturalWidth} px` : item.width ? `${item.width} px` : '?';

  return (
    <article
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-[rgba(16,11,8,.6)] transition hover:-translate-y-0.5 hover:shadow-[0_8px_32px_-12px_rgba(216,153,33,.18)] ${border}`}
      onClick={onToggle}
      role="checkbox"
      aria-checked={selected}
      aria-label={`${selected ? 'Deselect' : 'Select'} ${item.name}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggle(); }
      }}
    >
      <span
        aria-hidden
        className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[.7rem] font-bold transition ${
          selected
            ? 'bg-bronze text-[rgba(10,8,6,1)]'
            : 'border border-line bg-[rgba(10,8,6,.7)] text-muted group-hover:border-bronze/60'
        }`}
      >
        {selected ? '✓' : ''}
      </span>

      {/* corner actions (stop propagation so they don't toggle selection) */}
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        {onFindSource && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onFindSource(); }}
            aria-label={`Find the source of ${item.name}`}
            title="Reverse-image search: find the source / a higher-res original"
            className="rounded-full border border-line bg-[rgba(10,8,6,.7)] px-2 py-0.5 font-mono text-[.6rem] text-muted opacity-0 transition hover:border-bronze/60 hover:text-bronze-bright focus-visible:opacity-100 group-hover:opacity-100"
          >
            🔍
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPreview(); }}
          aria-label={`Preview ${item.name}`}
          className="rounded-full border border-line bg-[rgba(10,8,6,.7)] px-2 py-0.5 font-mono text-[.6rem] text-muted opacity-0 transition hover:border-bronze/60 hover:text-bronze-bright focus-visible:opacity-100 group-hover:opacity-100"
        >
          ⤢
        </button>
      </div>

      {dlStatus && (
        <span
          aria-hidden
          className="absolute right-2 bottom-[2.6rem] z-10 flex items-center gap-1 rounded-sm bg-[rgba(10,8,6,.88)] px-1.5 py-0.5 font-mono text-[.62rem] text-bronze"
        >
          {dlStatus === 'downloading' && <><Spinner small />fetching…</>}
          {dlStatus === 'done' && '✓ saved'}
          {dlStatus === 'error' && '⚠ error'}
        </span>
      )}

      <div className="relative aspect-[4/3] overflow-hidden bg-[rgba(10,8,6,.8)]">
        <img
          src={displaySrc(item.url)}
          alt={item.name}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.03]"
          onLoad={(e) => onLoad((e.currentTarget as HTMLImageElement).naturalWidth)}
          onError={onError}
        />
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="flex-1 truncate font-mono text-[.7rem] text-muted" title={item.name}>
          {item.name}
        </p>
        <span className="shrink-0 rounded-sm bg-bronze/10 px-1.5 py-0.5 font-mono text-[.62rem] text-bronze">
          {widthLabel}
        </span>
      </div>
    </article>
  );
}

// ─── Art card (search mode: per-variant downloads + metadata, click to preview) ─

function SourceBadge({ source }: { source: ArtItem['source'] }) {
  const labels: Record<ArtItem['source'], string> = {
    aic: 'AIC', met: 'Met', cleveland: 'Cleveland', commons: 'Commons', wikiart: 'WikiArt', vam: 'V&A', wellcome: 'Wellcome', smk: 'SMK', nasjonalmuseet: 'Nasjonalmus.', digitalnz: 'DigitalNZ', wikidata: 'Wikidata', europeana: 'Europeana', harvard: 'Harvard', si: 'Smithsonian', parismusees: 'Paris Musées', moma: 'MoMA', nga: 'NGA', mia: 'MIA', loc: 'Library of Congress', nypl: 'NYPL', dumps: 'Open data', iiif: 'IIIF',
  };
  return (
    <span className="rounded-sm bg-bronze/15 px-1.5 py-0.5 font-mono text-[.65rem] text-bronze">
      {labels[source]}
    </span>
  );
}

function MetaChips({ item }: { item: ArtItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[.62rem] uppercase text-muted">
        {item.format}
      </span>
      {item.width && item.height && (
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[.62rem] text-muted">
          {item.width}×{item.height}
        </span>
      )}
      {item.lossless && (
        <span className="rounded-sm border border-bronze/40 bg-bronze/10 px-1.5 py-0.5 font-mono text-[.62rem] text-bronze-bright">
          ◆ lossless
        </span>
      )}
      {item.width && item.height && fitsScreen(item.width, item.height) && (
        <span
          title="Big enough for a crisp wallpaper at your screen resolution"
          className="rounded-sm border border-bronze/40 bg-bronze/10 px-1.5 py-0.5 font-mono text-[.62rem] text-bronze-bright"
        >
          ▣ wallpaper-ready
        </span>
      )}
    </div>
  );
}

function ArtCard({
  item, onPreview, onAnalyze, onShare, siblings, analyzeEnabled,
}: {
  item: ArtItem;
  onPreview: () => void;
  onAnalyze: () => void;
  onShare: () => void;
  siblings: number;      // how many sources (incl. this) describe the same work
  analyzeEnabled: boolean;
}) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-line bg-[rgba(16,11,8,.6)] transition hover:-translate-y-0.5 hover:border-bronze/60 hover:shadow-[0_8px_32px_-12px_rgba(216,153,33,.18)]">
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview ${item.title}`}
        className="relative aspect-[4/3] cursor-zoom-in overflow-hidden bg-[rgba(10,8,6,.8)] outline-none focus-visible:ring-2 focus-visible:ring-bronze/60"
      >
        <img
          src={displaySrc(item.thumbUrl)}
          alt={`${item.title}${item.artist ? `, by ${item.artist}` : ''}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.03]"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        <PreviewBadge />
        {!item.isPublicDomain && (
          <span className="absolute left-2 top-2 rounded-sm bg-[rgba(10,8,6,.82)] px-1.5 py-0.5 font-mono text-[.62rem] text-muted">
            © rights may apply
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="flex-1 font-display text-[.9rem] font-medium leading-snug text-ink">{item.title}</h3>
          <SourceBadge source={item.source} />
        </div>
        {item.artist && <p className="text-[.82rem] text-muted">{item.artist}</p>}
        {(item.date || item.medium || item.culture) && (
          <p className="text-[.74rem] text-muted/80">{[item.date, item.medium, item.culture].filter(Boolean).join(' · ')}</p>
        )}
        {item.dimensions && <p className="font-mono text-[.72rem] text-muted/70">{item.dimensions}</p>}
        {item.description && (
          <p className="line-clamp-3 text-[.76rem] leading-snug text-muted/75">{item.description}</p>
        )}
        {item.creditLine && (
          <p className="text-[.7rem] italic leading-snug text-muted/55">{item.creditLine}</p>
        )}
        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener"
            className="font-mono text-[.7rem] text-bronze/80 transition hover:text-bronze-bright"
          >
            ↗ view at source
          </a>
        )}

        <div className="mt-0.5"><MetaChips item={item} /></div>

        {analyzeEnabled && (
          <button
            type="button"
            onClick={onAnalyze}
            className="flex items-center justify-center gap-1.5 rounded-md border border-bronze/40 bg-bronze/[.07] px-3 py-1.5 font-mono text-[.72rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/15"
          >
            ✦ {siblings > 1 ? `Synthesize ${siblings} sources` : 'Deep analysis'}
          </button>
        )}

        <div className="mt-auto flex items-center gap-2 pt-2">
          <DownloadMenu fullUrl={item.fullUrl} title={item.title} artist={item.artist} />
          <button
            type="button"
            onClick={onShare}
            title="Copy a shareable link to this work"
            aria-label="Copy a shareable link to this work"
            className="rounded border border-line px-2.5 py-1.5 font-mono text-[.78rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright"
          >
            ⧉
          </button>
        </div>
      </div>
    </article>
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

  // art state
  const [artItems, setArtItems] = useState<ArtItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [losslessOnly, setLosslessOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [streaming, setStreaming] = useState(false);   // SSE search in progress
  const [shown, setShown] = useState(SHOWN_STEP);       // infinite-scroll window
  const streamCancelRef = useRef<null | (() => void)>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // shared lightbox (index into the currently-visible list)
  const [lightboxIndex, setLightboxIndex] = useState(-1);

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
    | { phase: 'loading' | 'done' | 'error'; title: string; text?: string; contributors?: string[]; cached?: boolean; message?: string }
  >(null);

  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setLightboxIndex(-1);
    setMode('loading');
    setError('');

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

    // Any other URL → scan the page for images
    if (isURL(q)) {
      setImages([]); setSelected(new Set()); setDlMap(new Map()); setDlBusy(false); setDlDone(false);
      setPageUrl(q); setQuery(q);
      try {
        const res = await fetch(`/api/scan?url=${encodeURIComponent(q)}`);
        const json: { images?: ImageCandidate[]; error?: string; sauceEnabled?: boolean } = await res.json();
        if (!res.ok) { setError(json.error ?? `Server error ${res.status}`); setMode('error'); return; }
        setSauceEnabled(Boolean(json.sauceEnabled));
        const candidates = json.images ?? [];
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
      setArtItems(items); setMode('art');
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
  const runExample = (ex: string) => { setInput(ex); inputRef.current?.focus(); run(ex); };

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
  const visibleArt = useMemo(
    () => (losslessOnly ? artItems.filter((i) => i.lossless) : artItems),
    [artItems, losslessOnly],
  );
  const losslessCount = useMemo(() => artItems.filter((i) => i.lossless).length, [artItems]);

  // group items that describe the same work (across sources) for synthesis
  const siblingsByKey = useMemo(() => {
    const m = new Map<string, ArtItem[]>();
    for (const it of artItems) {
      const k = workKey(it);
      (m.get(k) ?? m.set(k, []).get(k)!).push(it);
    }
    return m;
  }, [artItems]);

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
      setAnalysis({ phase: 'done', title: item.title, text: json.analysis, contributors: json.contributors, cached: json.cached });
    } catch (e) {
      setAnalysis({ phase: 'error', title: item.title, message: e instanceof Error ? e.message : 'Network error' });
    }
  }, [siblingsByKey]);

  // ── lightbox slides (built from whichever list is showing) ──
  // Both modes feed the SAME MediaLightbox with the same slide shape
  // (src + title + description + proxied download), so the viewer and its
  // captions behave identically whether you scanned a URL or searched a museum.
  const slides: LightboxSlide[] = useMemo(() => {
    if (mode === 'scan') {
      return visibleScan.map(([img]) => {
        const dims = img.naturalWidth > 0 ? `${img.naturalWidth} px wide` : '';
        let host = '';
        try { host = new URL(img.url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
        return {
          src: displaySrc(img.url, pageUrl || undefined),
          title: img.name,
          description: [dims, host && `from ${host}`].filter(Boolean).join(' · '),
          downloadUrl: proxyUrl(img.url, pageUrl || undefined),
          downloadFilename: img.name,
        };
      });
    }
    if (mode === 'art') {
      return visibleArt.map((it) => {
        const best = it.downloads[0] ?? { url: it.fullUrl, format: it.format, label: 'Download' };
        const facts = [it.artist, it.date, it.medium, it.culture].filter(Boolean).join(' · ');
        return {
          src: displaySrc(it.previewUrl || it.fullUrl),
          title: it.title,
          description: [facts, it.description, it.creditLine].filter(Boolean).join('\n\n'),
          downloadUrl: proxyUrl(best.url),
          downloadFilename: safeName(it.title, it.artist, extFor(best.format)),
        };
      });
    }
    return [];
  }, [mode, visibleScan, visibleArt, pageUrl]);

  // ── shareable links (zero extra cost: pure client-side URL state) ──
  // The current search lives in the URL as ?q=<term>; an open slide adds &v=<id>.
  // Opening a shared link just re-runs the same search against the same endpoints,
  // so it costs exactly what a normal search does — nothing extra.
  const pendingViewRef = useRef<string | null>(null);
  const [shareMsg, setShareMsg] = useState('');

  // Slide identity used in the URL: art uses the stable item id; scan uses the URL.
  const slideShareId = useCallback(
    (idx: number): string | undefined =>
      mode === 'art' ? visibleArt[idx]?.id : mode === 'scan' ? visibleScan[idx]?.[0]?.url : undefined,
    [mode, visibleArt, visibleScan],
  );

  const buildShareUrl = useCallback(
    (viewId?: string): string => {
      const term = mode === 'scan' ? pageUrl : query;
      const params = new URLSearchParams();
      if (term) params.set('q', term);
      if (viewId) params.set('v', viewId);
      return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    },
    [mode, pageUrl, query],
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

  // Hydrate from the URL on first load: ?q= runs the search, ?v= opens that slide.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const v = params.get('v');
    if (v) pendingViewRef.current = v;
    if (q) { setInput(q); run(q); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once results are in, open the deep-linked slide (works while streaming, too).
  useEffect(() => {
    const v = pendingViewRef.current;
    if (!v) return;
    const idx =
      mode === 'art'
        ? visibleArt.findIndex((it) => it.id === v)
        : mode === 'scan'
          ? visibleScan.findIndex(([img]) => img.url === v)
          : -1;
    if (idx >= 0) { setLightboxIndex(idx); pendingViewRef.current = null; }
  }, [mode, visibleArt, visibleScan]);

  // Keep the address bar in sync (replaceState → no history spam during streaming).
  useEffect(() => {
    if (mode !== 'art' && mode !== 'scan') return;
    const term = mode === 'scan' ? pageUrl : query;
    if (!term) return;
    const params = new URLSearchParams({ q: term });
    if (lightboxIndex >= 0) {
      const id = slideShareId(lightboxIndex);
      if (id) params.set('v', id);
    }
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [mode, query, pageUrl, lightboxIndex, slideShareId]);

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

  const EXAMPLES: Array<{ label: string; value: string }> = [
    { label: 'Starry Night', value: 'Starry Night' },
    { label: 'The Birth of Venus', value: 'The Birth of Venus' },
    { label: 'a web page ↗', value: 'https://en.wikipedia.org/wiki/Perseus' },
  ];

  return (
    <section id="finder" aria-label="Find and download images" className="w-full">
      {/* the one search box */}
      <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-[680px] flex-col gap-2 sm:flex-row">
        <label htmlFor={inputId} className="sr-only">Paste a link, or search for art</label>
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          inputMode="url"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a link, or search for art…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck="false"
          className="flex-1 rounded-lg border border-line bg-[rgba(14,10,7,.82)] px-4 py-3 font-mono text-[.92rem] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.03)] outline-none transition placeholder:text-muted/55 focus:border-bronze/70 focus:ring-2 focus:ring-bronze/25"
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

      {/* one-line explainer + examples */}
      <p className="mx-auto mt-3 max-w-[600px] text-center text-[.82rem] text-muted">
        Paste a page or gallery <strong className="font-semibold text-ink/80">URL</strong> to grab its
        images — or type an <strong className="font-semibold text-ink/80">artwork or artist</strong> to
        search the world's museums.
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.value}
            type="button"
            onClick={() => runExample(ex.value)}
            className="rounded-full border border-line px-3 py-1 font-mono text-[.72rem] text-muted transition hover:border-bronze/60 hover:text-bronze"
          >
            {ex.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-center font-mono text-[.68rem] tracking-[0.04em] text-muted/55">
        millions of works across 15 open collections — the Met · Art Institute of Chicago · Cleveland · V&amp;A ·
        Wellcome · Harvard · Smithsonian · Library of Congress · SMK · Nasjonalmuseet · Europeana · Wikidata · DigitalNZ · WikiArt · Wikimedia Commons
      </p>

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
          </div>
        )}

        {/* SCAN results */}
        {mode === 'scan' && (
          <div aria-live="polite">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="font-mono text-[.78rem] text-muted/70">
                {visibleScan.length} image{visibleScan.length !== 1 ? 's' : ''} found
                {selected.size > 0 && <span className="ml-2 text-bronze">{selected.size} selected</span>}
              </p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={selectAll} className="rounded-md border border-line px-3 py-1.5 font-mono text-[.75rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">Select all</button>
                <button type="button" onClick={clearAll} className="rounded-md border border-line px-3 py-1.5 font-mono text-[.75rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">Clear</button>
                <button type="button" onClick={() => copyShare()} title="Copy a shareable link to these results" className="rounded-md border border-line px-3 py-1.5 font-mono text-[.75rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright">⧉ Share</button>
                <button
                  type="button"
                  onClick={downloadSelected}
                  disabled={selected.size === 0 || dlBusy}
                  className="flex items-center gap-2 rounded-md border border-bronze/45 bg-bronze/10 px-4 py-1.5 font-mono text-[.8rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {dlBusy && <Spinner small />}
                  {dlDone ? 'Done ✓' : `Download${selected.size > 0 ? ` ${selected.size}` : ''}`}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
              {visibleScan.map(([item, originalIdx], visIdx) => (
                <ScanCard
                  key={originalIdx}
                  item={item}
                  selected={selected.has(originalIdx)}
                  onToggle={() => toggleSelect(originalIdx)}
                  onPreview={() => setLightboxIndex(visIdx)}
                  onFindSource={sauceEnabled ? () => findSource(item.url) : undefined}
                  onLoad={(nw) => handleLoad(originalIdx, nw)}
                  onError={() => handleError(originalIdx)}
                  dlStatus={dlMap.get(originalIdx)}
                />
              ))}
            </div>

            <div className="mt-10 rounded-xl border border-line bg-[rgba(14,10,7,.55)] px-5 py-4">
              <p className="font-mono text-[.75rem] leading-relaxed text-muted/80">
                <span className="font-semibold text-muted">Works on:</span> static pages, blogs, galleries,
                museum sites, Wikipedia, news.{'  '}
                <span className="font-semibold text-muted">Needs the CLI/extension:</span> video and
                login-walled social sites (Instagram, X, YouTube) — a server can't see your session.
              </p>
            </div>
          </div>
        )}

        {/* ART results */}
        {mode === 'art' && (
          <div aria-live="polite">
            {warnings.length > 0 && (
              <p className="mb-4 text-center font-mono text-[.75rem] text-amber/80">
                Partial results — some sources failed: {warnings.join(' · ')}
              </p>
            )}
            <div className="mb-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <p className="font-mono text-[.78rem] text-muted/70">
                {visibleArt.length} work{visibleArt.length !== 1 ? 's' : ''}
                {losslessOnly && ` of ${artItems.length}`}
                {streaming && <span className="ml-2 text-bronze">· searching…</span>}
              </p>
              <button
                type="button"
                onClick={() => setLosslessOnly((v) => !v)}
                disabled={losslessCount === 0}
                aria-pressed={losslessOnly}
                className={
                  'rounded-full border px-3 py-1 font-mono text-[.72rem] transition disabled:cursor-not-allowed disabled:opacity-40 ' +
                  (losslessOnly
                    ? 'border-bronze/60 bg-bronze/15 text-bronze-bright'
                    : 'border-line text-muted hover:border-bronze/60 hover:text-bronze')
                }
              >
                {losslessOnly ? '◆ lossless only ✓' : `◆ lossless only (${losslessCount})`}
              </button>
              <button
                type="button"
                onClick={() => copyShare()}
                title="Copy a shareable link to this search"
                className="rounded-full border border-line px-3 py-1 font-mono text-[.72rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright"
              >
                ⧉ share search
              </button>
            </div>

            {visibleArt.length === 0 ? (
              <p className="text-center font-mono text-[.82rem] text-muted/60">
                No lossless originals in these results.{' '}
                <button type="button" onClick={() => setLosslessOnly(false)} className="text-bronze hover:text-bronze-bright">Show all →</button>
              </p>
            ) : (
              <>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
                  {visibleArt.slice(0, shown).map((item, i) => (
                    <ArtCard
                      key={item.id}
                      item={item}
                      onPreview={() => setLightboxIndex(i)}
                      onAnalyze={() => analyzeWork(item)}
                      onShare={() => copyShare(item.id)}
                      siblings={siblingsByKey.get(workKey(item))?.length ?? 1}
                      analyzeEnabled={analyzeEnabled}
                    />
                  ))}
                </div>
                {shown < visibleArt.length && (
                  <div ref={sentinelRef} className="h-12" aria-hidden />
                )}
              </>
            )}

            <p className="mt-8 text-center font-mono text-[.74rem] text-muted/50">
              Want gigapixel tile-stitching, V&amp;A, Rijksmuseum &amp; 1,800+ other sites?{' '}
              <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">Install Harpe →</a>
            </p>
          </div>
        )}
      </div>

      {/* the one viewer, shared by both result kinds */}
      <MediaLightbox slides={slides} index={lightboxIndex} onClose={() => setLightboxIndex(-1)} />

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
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(8,6,4,.8)] p-4 backdrop-blur-sm"
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
      {analysis && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Synthesized analysis"
          onClick={() => setAnalysis(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(8,6,4,.8)] p-4 backdrop-blur-sm"
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
            {analysis.phase === 'done' && (
              <>
                <p className="whitespace-pre-wrap text-[.9rem] leading-relaxed text-ink/90">{analysis.text}</p>
                {analysis.contributors && analysis.contributors.length > 0 && (
                  <p className="mt-4 border-t border-line pt-3 font-mono text-[.7rem] text-muted/70">
                    Synthesized from: {analysis.contributors.join(' · ')}
                    {analysis.cached ? ' · cached' : ''}
                  </p>
                )}
                <p className="mt-2 font-mono text-[.66rem] text-muted/50">AI-generated from the sources' metadata — may contain errors.</p>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
