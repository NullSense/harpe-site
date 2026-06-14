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

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import MediaLightbox from './components/MediaLightbox';
import {
  type DownloadVariant,
  type LightboxSlide,
  LOSSLESS_FORMATS,
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
  source: 'aic' | 'met' | 'cleveland' | 'commons' | 'wikiart' | 'vam' | 'wellcome' | 'iiif';
  isPublicDomain: boolean;
}

type Mode = 'idle' | 'loading' | 'scan' | 'art' | 'empty' | 'error';
type DlStatus = 'downloading' | 'done' | 'error';

const MIN_WIDTH = 100;

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
  onLoad,
  onError,
  dlStatus,
}: {
  item: ScanImage;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
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

      {/* preview button (stops propagation so it doesn't toggle selection) */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onPreview(); }}
        aria-label={`Preview ${item.name}`}
        className="absolute right-2 top-2 z-10 rounded-full border border-line bg-[rgba(10,8,6,.7)] px-2 py-0.5 font-mono text-[.6rem] text-muted opacity-0 transition hover:border-bronze/60 hover:text-bronze-bright focus-visible:opacity-100 group-hover:opacity-100"
      >
        ⤢
      </button>

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
          src={item.url}
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
    aic: 'AIC', met: 'Met', cleveland: 'Cleveland', commons: 'Commons', wikiart: 'WikiArt', vam: 'V&A', wellcome: 'Wellcome', iiif: 'IIIF',
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
      {item.lossless ? (
        <span className="rounded-sm border border-bronze/40 bg-bronze/10 px-1.5 py-0.5 font-mono text-[.62rem] text-bronze-bright">
          ◆ lossless
        </span>
      ) : (
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[.62rem] text-muted/60">
          lossy
        </span>
      )}
    </div>
  );
}

function ArtCard({ item, onPreview }: { item: ArtItem; onPreview: () => void }) {
  const [dl, setDl] = useState<'idle' | 'fetching' | 'done' | 'error'>('idle');
  const [activeLabel, setActiveLabel] = useState('');

  const handleDownload = async (v: DownloadVariant) => {
    if (dl === 'fetching') return;
    setDl('fetching');
    setActiveLabel(v.label);
    try {
      await downloadViaProxy(v.url, safeName(item.title, item.artist, extFor(v.format)));
      setDl('done');
      setTimeout(() => setDl('idle'), 3500);
    } catch {
      setDl('error');
      setTimeout(() => setDl('idle'), 3000);
    }
  };

  const downloads = item.downloads.length
    ? item.downloads
    : [{ label: 'Download', url: item.fullUrl, format: item.format, lossless: item.lossless }];

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-line bg-[rgba(16,11,8,.6)] transition hover:-translate-y-0.5 hover:border-bronze/60 hover:shadow-[0_8px_32px_-12px_rgba(216,153,33,.18)]">
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview ${item.title}`}
        className="relative aspect-[4/3] cursor-zoom-in overflow-hidden bg-[rgba(10,8,6,.8)] outline-none focus-visible:ring-2 focus-visible:ring-bronze/60"
      >
        <img
          src={item.thumbUrl}
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
        {item.dimensions && <p className="font-mono text-[.72rem] text-muted/70">{item.dimensions}</p>}

        <div className="mt-0.5"><MetaChips item={item} /></div>

        <div className="mt-auto flex flex-col gap-1.5 pt-2">
          {downloads.map((v, i) => {
            const busy = dl === 'fetching' && activeLabel === v.label;
            const label = busy
              ? 'Fetching…'
              : dl === 'done' && activeLabel === v.label
                ? 'Saved ✓'
                : dl === 'error' && activeLabel === v.label
                  ? 'Error — retry?'
                  : v.label + (v.lossless ? ' · lossless' : '');
            const primary = i === 0;
            return (
              <button
                key={v.label}
                onClick={() => handleDownload(v)}
                disabled={dl === 'fetching'}
                aria-label={`Download ${v.label} — ${item.title}`}
                className={
                  'flex items-center justify-center gap-2 rounded-md px-3 py-1.5 font-mono text-[.74rem] transition disabled:cursor-not-allowed disabled:opacity-50 ' +
                  (primary
                    ? 'border border-bronze/45 bg-bronze/10 text-bronze-bright hover:border-bronze hover:bg-bronze/20'
                    : 'border border-line text-muted hover:border-bronze/60 hover:text-bronze')
                }
              >
                {busy && <Spinner small />}
                {!busy && <span aria-hidden>⬇</span>}
                {label}
              </button>
            );
          })}
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

  // shared lightbox (index into the currently-visible list)
  const [lightboxIndex, setLightboxIndex] = useState(-1);

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
      setPageUrl(q);
      try {
        const res = await fetch(`/api/scan?url=${encodeURIComponent(q)}`);
        const json: { images?: ImageCandidate[]; error?: string } = await res.json();
        if (!res.ok) { setError(json.error ?? `Server error ${res.status}`); setMode('error'); return; }
        const candidates = json.images ?? [];
        if (candidates.length === 0) { setMode('empty'); return; }
        setImages(candidates.map((c) => ({ ...c, naturalWidth: -1, loaded: false })));
        setMode('scan');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error'); setMode('error');
      }
      return;
    }

    // Plain text → museum search
    setQuery(q);
    try {
      const res = await fetch(`/api/art?q=${encodeURIComponent(q)}`);
      const json: { items?: unknown[]; warnings?: string[]; error?: string } = await res.json();
      if (!res.ok) { setError(json.error ?? `Server error ${res.status}`); setMode('error'); return; }
      const w: string[] = Array.isArray(json.warnings) ? json.warnings : [];
      const items = (json.items ?? []).map(normalizeArt);
      setWarnings(w);
      if (items.length === 0) { setMode('empty'); return; }
      setArtItems(items);
      setMode('art');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error'); setMode('error');
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

  // ── lightbox slides (built from whichever list is showing) ──
  const slides: LightboxSlide[] = useMemo(() => {
    if (mode === 'scan') {
      return visibleScan.map(([img]) => ({
        src: img.url,
        title: img.name,
        downloadUrl: proxyUrl(img.url, pageUrl || undefined),
        downloadFilename: img.name,
      }));
    }
    if (mode === 'art') {
      return visibleArt.map((it) => {
        const best = it.downloads[0] ?? { url: it.fullUrl, format: it.format, label: 'Download' };
        return {
          src: it.previewUrl || it.fullUrl,
          title: it.title,
          description: [it.artist, it.dimensions].filter(Boolean).join(' · '),
          downloadUrl: proxyUrl(best.url),
          downloadFilename: safeName(it.title, it.artist, extFor(best.format)),
        };
      });
    }
    return [];
  }, [mode, visibleScan, visibleArt, pageUrl]);

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
        art search spans Art Institute of Chicago · The Met · Cleveland · V&amp;A · Wellcome · WikiArt · Wikimedia Commons
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
                {losslessOnly && ` of ${artItems.length}`} shown
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
            </div>

            {visibleArt.length === 0 ? (
              <p className="text-center font-mono text-[.82rem] text-muted/60">
                No lossless originals in these results.{' '}
                <button type="button" onClick={() => setLosslessOnly(false)} className="text-bronze hover:text-bronze-bright">Show all →</button>
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
                {visibleArt.map((item, i) => (
                  <ArtCard key={item.id} item={item} onPreview={() => setLightboxIndex(i)} />
                ))}
              </div>
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
    </section>
  );
}
