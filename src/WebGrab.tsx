/**
 * WebGrab — paste a URL, find its images, pick, download.
 *
 * Uses two Vercel serverless functions:
 *   GET /api/scan?url=<page>               → { images: [{url, name, width?}] }
 *   GET /api/fetch?url=<img>&referer=<page> → streams image bytes as a download
 *
 * The card's visible <img> src = the candidate URL so the browser renders it
 * and we can read naturalWidth to sort biggest-first and hide sub-100 px icons.
 *
 * Limitations (shown in the UI):
 *   Static HTML only — JS-rendered/lazy galleries and login-walled sites
 *   (Instagram, X, YouTube) need the Harpe CLI or browser extension.
 */

import { useCallback, useId, useRef, useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ImageCandidate {
  url: string;
  name: string;
  width?: number; // srcset / URL hint if available from scan
}

interface DisplayImage extends ImageCandidate {
  naturalWidth: number; // -1 = not yet loaded / error
  loaded: boolean;      // true once the <img> fires load or error
}

type Phase = 'idle' | 'loading' | 'results' | 'empty' | 'error';

type DlStatus = 'downloading' | 'done' | 'error';

const MIN_WIDTH = 100; // px — skip icons / UI chrome

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    <div
      aria-hidden
      className="overflow-hidden rounded-xl border border-line bg-[rgba(16,11,8,.6)]"
    >
      <div className="aspect-[4/3] animate-pulse bg-bronze/10" />
      <div className="h-5 mx-3 mt-3 mb-3 animate-pulse rounded bg-bronze/10" />
    </div>
  );
}

// ─── Image card ───────────────────────────────────────────────────────────────

interface ImageCardProps {
  item: DisplayImage;
  selected: boolean;
  onToggle: () => void;
  onLoad: (nw: number) => void;
  onError: () => void;
  dlStatus: DlStatus | undefined;
}

function ImageCard({ item, selected, onToggle, onLoad, onError, dlStatus }: ImageCardProps) {
  const border = selected
    ? 'border-bronze shadow-[0_4px_24px_-8px_rgba(216,153,33,.35)]'
    : 'border-line hover:border-bronze/60';

  const checkRing = selected
    ? 'bg-bronze text-[rgba(10,8,6,1)]'
    : 'bg-[rgba(10,8,6,.7)] text-muted border border-line group-hover:border-bronze/60';

  const widthLabel =
    item.naturalWidth > 0 ? `${item.naturalWidth} px` : item.width ? `${item.width} px` : '?';

  return (
    <article
      className={`group relative flex flex-col overflow-hidden rounded-xl border transition cursor-pointer
        bg-[rgba(16,11,8,.6)] ${border} hover:-translate-y-0.5
        hover:shadow-[0_8px_32px_-12px_rgba(216,153,33,.18)]`}
      onClick={onToggle}
      role="checkbox"
      aria-checked={selected}
      aria-label={`${selected ? 'Deselect' : 'Select'} ${item.name}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggle(); }
      }}
    >
      {/* selection ring */}
      <span
        aria-hidden
        className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center
          rounded-full text-[.7rem] font-bold transition ${checkRing}`}
      >
        {selected ? '✓' : ''}
      </span>

      {/* download status badge */}
      {dlStatus && (
        <span
          aria-hidden
          className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-sm
            bg-[rgba(10,8,6,.88)] px-1.5 py-0.5 font-mono text-[.62rem] text-bronze"
        >
          {dlStatus === 'downloading' && <><Spinner small />fetching…</>}
          {dlStatus === 'done' && '✓ saved'}
          {dlStatus === 'error' && '⚠ error'}
        </span>
      )}

      {/* thumbnail */}
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

      {/* name + size */}
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function WebGrab() {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [images, setImages] = useState<DisplayImage[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dlMap, setDlMap] = useState<Map<number, DlStatus>>(new Map());
  const [dlBusy, setDlBusy] = useState(false);
  const [dlDone, setDlDone] = useState(false);

  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Scan ──────────────────────────────────────────────────────────────────

  const scan = useCallback(async (raw: string) => {
    const target = raw.trim();
    if (!target) return;

    setPhase('loading');
    setImages([]);
    setSelected(new Set());
    setDlMap(new Map());
    setDlBusy(false);
    setDlDone(false);
    setPageUrl(target);

    try {
      const res = await fetch(`/api/scan?url=${encodeURIComponent(target)}`);
      const json: { images?: ImageCandidate[]; error?: string } = await res.json();

      if (!res.ok) {
        setErrorMsg(json.error ?? `Server error ${res.status}`);
        setPhase('error');
        return;
      }

      const candidates = json.images ?? [];
      if (candidates.length === 0) {
        setPhase('empty');
        return;
      }

      const items: DisplayImage[] = candidates.map((c) => ({
        ...c,
        naturalWidth: -1,
        loaded: false,
      }));
      setImages(items);
      setPhase('results');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Network error');
      setPhase('error');
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    scan(url);
  };

  // ── naturalWidth updates ──────────────────────────────────────────────────

  const handleLoad = useCallback((idx: number, nw: number) => {
    setImages((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], naturalWidth: nw, loaded: true };
      return next;
    });
  }, []);

  const handleError = useCallback((idx: number) => {
    setImages((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], naturalWidth: -1, loaded: true };
      return next;
    });
  }, []);

  // ── Visible list sorted by naturalWidth desc ──────────────────────────────

  // Pairs of (DisplayImage, originalIndex) for images worth showing
  const visible: Array<[DisplayImage, number]> = images
    .map((img, i) => [img, i] as [DisplayImage, number])
    // Keep: not yet loaded (still pending), or naturalWidth ≥ MIN_WIDTH
    .filter(([img]) => !img.loaded || img.naturalWidth >= MIN_WIDTH)
    .sort(([a], [b]) => {
      const wa = a.naturalWidth > 0 ? a.naturalWidth : 0;
      const wb = b.naturalWidth > 0 ? b.naturalWidth : 0;
      if (wa > 0 && wb > 0) return wb - wa;
      if (wa > 0) return -1; // known after unknown
      if (wb > 0) return 1;
      return 0;
    });

  // ── Selection ─────────────────────────────────────────────────────────────

  const toggleSelect = useCallback((idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }, []);

  const selectAll = () =>
    setSelected(new Set(visible.map(([, i]) => i)));

  const clearAll = () => setSelected(new Set());

  // ── Download ──────────────────────────────────────────────────────────────

  const downloadSelected = async () => {
    if (selected.size === 0 || dlBusy) return;
    setDlBusy(true);
    setDlDone(false);

    const queue = [...selected]
      .map((idx) => ({ idx, item: images[idx] }))
      .filter(({ item }) => item !== undefined);

    const map = new Map<number, DlStatus>(queue.map(({ idx }) => [idx, 'downloading']));
    setDlMap(new Map(map));

    for (const { idx, item } of queue) {
      try {
        const params = new URLSearchParams({ url: item.url });
        if (pageUrl) params.set('referer', pageUrl);
        const res = await fetch(`/api/fetch?${params.toString()}`);
        if (!res.ok) {
          map.set(idx, 'error');
          setDlMap(new Map(map));
          continue;
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
        map.set(idx, 'done');
        setDlMap(new Map(map));
      } catch {
        map.set(idx, 'error');
        setDlMap(new Map(map));
      }
    }

    setDlBusy(false);
    setDlDone(true);
    setTimeout(() => {
      setDlDone(false);
      setDlMap(new Map());
    }, 4_000);
  };

  const EXAMPLE_URL = 'https://en.wikipedia.org/wiki/Perseus';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <section
      id="web-grab"
      aria-label="Page image finder"
      className="pb-16 pt-20"
    >
      {/* heading */}
      <div className="mb-10 text-center">
        <span className="mb-3 block font-mono text-[.8rem] tracking-[0.12em] text-bronze">
          ⊞ TRY IT — NO INSTALL
        </span>
        <h2 className="font-display text-[clamp(1.3rem,3vw,2rem)] font-medium">
          Paste a URL → find its images → pick → download
        </h2>
        <p className="mx-auto mt-3 max-w-[560px] text-[.95rem] text-muted">
          A server fetches the page on your behalf — no CORS, no browser
          extension. It extracts every image candidate, biggest first. Click to
          select; download directly to your device.
        </p>
      </div>

      {/* form */}
      <form
        onSubmit={handleSubmit}
        className="mx-auto mb-4 flex max-w-[660px] gap-2"
      >
        <label htmlFor={inputId} className="sr-only">
          Page URL to scan for images
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/page-with-images"
          autoComplete="url"
          spellCheck="false"
          className="flex-1 rounded-md border border-line bg-[rgba(14,10,7,.78)] px-4 py-2.5 font-mono text-[.88rem] text-ink placeholder:text-muted/60 outline-none transition focus:border-bronze/70 focus:ring-1 focus:ring-bronze/30"
        />
        <button
          type="submit"
          disabled={phase === 'loading' || !url.trim()}
          className="flex items-center gap-2 rounded-md border border-bronze/45 bg-bronze/10 px-5 py-2.5 font-mono text-[.88rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {phase === 'loading' && <Spinner />}
          Find images
        </button>
      </form>

      {/* example chip */}
      <div className="mb-8 flex justify-center">
        <button
          type="button"
          onClick={() => {
            setUrl(EXAMPLE_URL);
            scan(EXAMPLE_URL);
          }}
          className="rounded-full border border-line px-3 py-1 font-mono text-[.72rem] text-muted transition hover:border-bronze/60 hover:text-bronze"
        >
          try: Wikipedia · Perseus
        </button>
      </div>

      {/* states */}
      {phase === 'idle' && (
        <p className="text-center font-mono text-[.82rem] text-muted/60">
          Enter any page URL above to extract its images.
        </p>
      )}

      {phase === 'loading' && (
        <div aria-live="polite" aria-label="Scanning page">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
            {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div
          role="alert"
          className="mx-auto max-w-[540px] rounded-xl border border-line bg-[rgba(16,11,8,.6)] p-6 text-center"
        >
          <span className="mb-2 block font-mono text-2xl text-bronze">⊘</span>
          <p className="text-[.9rem] text-muted">{errorMsg}</p>
        </div>
      )}

      {phase === 'empty' && (
        <div className="mx-auto max-w-[540px] rounded-xl border border-line bg-[rgba(16,11,8,.6)] p-6 text-center">
          <span className="mb-2 block font-mono text-2xl text-bronze">◈</span>
          <p className="text-[.9rem] text-muted">
            No images found in the page's static HTML.
          </p>
          <p className="mt-3 font-mono text-[.78rem] text-muted/60">
            Some pages render images via JavaScript after the initial HTML loads.
            For those, use the{' '}
            <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">
              Harpe CLI
            </a>{' '}
            or browser extension.
          </p>
        </div>
      )}

      {phase === 'results' && (
        <div aria-live="polite">
          {/* toolbar */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-[.78rem] text-muted/70">
              {visible.length} image{visible.length !== 1 ? 's' : ''} found
              {selected.size > 0 && (
                <span className="ml-2 text-bronze">{selected.size} selected</span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="rounded-md border border-line px-3 py-1.5 font-mono text-[.75rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="rounded-md border border-line px-3 py-1.5 font-mono text-[.75rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={downloadSelected}
                disabled={selected.size === 0 || dlBusy}
                className="flex items-center gap-2 rounded-md border border-bronze/45 bg-bronze/10 px-4 py-1.5 font-mono text-[.8rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {dlBusy && <Spinner small />}
                {dlDone
                  ? 'Done ✓'
                  : `Download${selected.size > 0 ? ` ${selected.size}` : ''}`}
              </button>
            </div>
          </div>

          {/* grid */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {visible.map(([item, originalIdx]) => (
              <ImageCard
                key={originalIdx}
                item={item}
                selected={selected.has(originalIdx)}
                onToggle={() => toggleSelect(originalIdx)}
                onLoad={(nw) => handleLoad(originalIdx, nw)}
                onError={() => handleError(originalIdx)}
                dlStatus={dlMap.get(originalIdx)}
              />
            ))}
          </div>

          {/* honest limitations note */}
          <div className="mt-10 rounded-xl border border-line bg-[rgba(14,10,7,.55)] px-5 py-4">
            <p className="font-mono text-[.75rem] text-muted/80 leading-relaxed">
              <span className="text-muted font-semibold">Works on:</span>{' '}
              static pages, blogs, galleries, museum sites, Wikipedia, news articles.
              {'  '}
              <span className="text-muted font-semibold">Needs the CLI or extension:</span>{' '}
              video and login-walled social sites (Instagram, X, YouTube) — a server
              can't see your session, and video needs yt-dlp. Use{' '}
              <a
                href="https://github.com/NullSense/harpe"
                className="text-bronze hover:text-bronze-bright"
              >
                <code className="font-mono">harpe -p &lt;url&gt;</code>
              </a>{' '}
              (CLI) or the{' '}
              <a
                href="https://github.com/NullSense/harpe"
                className="text-bronze hover:text-bronze-bright"
              >
                browser extension
              </a>{' '}
              for those.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
