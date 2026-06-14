/**
 * ArtGrab — museum art search & high-res download via server proxy.
 *
 * Uses two Vercel serverless functions:
 *   GET /api/art?q=<query>           → { items: ArtworkResult[], warnings: string[] }
 *   GET /api/fetch?url=<img>          → streams image bytes as a download
 *
 * The /api/art endpoint federates AIC, Met, and Cleveland server-side and
 * normalises all fields (including Cleveland's object-shaped `dimensions`) to
 * strings, so no object-as-React-child error (#31) can occur.
 *
 * IIIF: pasted IIIF manifest / info.json URLs are still detected and resolved
 * client-side (no auth needed, CORS-open servers) to the largest /full/full
 * derivative, then offered for download through the server proxy.
 */

import { useCallback, useId, useRef, useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArtworkResult {
  id: string;            // source:id
  title: string;
  artist: string;
  dimensions?: string;   // always a string from the server, or undefined
  thumbUrl: string;
  fullUrl: string;
  source: 'aic' | 'met' | 'cleveland' | 'commons' | 'wikiart' | 'iiif';
  isPublicDomain: boolean;
}

// ─── IIIF detection & resolution ─────────────────────────────────────────────

const IIIF_MANIFEST_RE =
  /https?:\/\/[^/]+(?:\/[^?#]*)?(?:manifest|info\.json)(?:[?#].*)?$/i;
const IIIF_INFO_RE = /^https?:\/\/.+\/info\.json$/i;

async function resolveIIIF(rawUrl: string): Promise<ArtworkResult | null> {
  let infoUrl = rawUrl;

  // If it's a manifest, try to extract the first canvas's image info URL
  if (!IIIF_INFO_RE.test(rawUrl)) {
    try {
      const manifestRes = await fetch(rawUrl);
      if (!manifestRes.ok) return null;
      const manifest = await manifestRes.json();
      // IIIF Presentation 2
      const img2 =
        manifest?.sequences?.[0]?.canvases?.[0]?.images?.[0]?.resource?.service?.['@id'];
      // IIIF Presentation 3
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
    const fullUrl = `${id.replace(/\/$/, '')}/full/full/0/default.jpg`;
    const thumbUrl = `${id.replace(/\/$/, '')}/full/400,/0/default.jpg`;
    const label = info.label;
    const title =
      typeof label === 'string'
        ? label
        : label?.en?.[0] ?? label?.none?.[0] ?? 'IIIF image';
    return {
      id: `iiif:${id}`,
      title: typeof title === 'string' ? title : 'IIIF image',
      artist: '',
      thumbUrl,
      fullUrl,
      source: 'iiif',
      isPublicDomain: true,
    };
  } catch {
    return null;
  }
}

// ─── Download helper ──────────────────────────────────────────────────────────

/**
 * Fetch the image through the server proxy (/api/fetch) and trigger a download.
 * This avoids CORS issues for museum image hosts.
 */
async function downloadViaProxy(url: string, filename: string): Promise<void> {
  const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
}

function safeName(title: string, artist: string, ext = 'jpg') {
  const slug = `${artist ? artist + ' - ' : ''}${title}`
    .replace(/[/\\:*?"<>|]/g, '')
    .slice(0, 80)
    .trim();
  return `${slug || 'artwork'}.${ext}`;
}

// ─── URL detection ────────────────────────────────────────────────────────────

const isURL = (s: string) => /^https?:\/\//i.test(s.trim());

// ─── Component pieces ─────────────────────────────────────────────────────────

type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'results'; items: ArtworkResult[]; query: string; warnings: string[] }
  | { phase: 'error'; message: string };

type DownloadState = 'idle' | 'fetching' | 'done' | 'error';

function SourceBadge({ source }: { source: ArtworkResult['source'] }) {
  const labels: Record<ArtworkResult['source'], string> = {
    aic: 'AIC',
    met: 'Met',
    cleveland: 'Cleveland',
    commons: 'Commons',
    wikiart: 'WikiArt',
    iiif: 'IIIF',
  };
  return (
    <span className="rounded-sm bg-bronze/15 px-1.5 py-0.5 font-mono text-[.65rem] text-bronze">
      {labels[source]}
    </span>
  );
}

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-bronze/30 border-t-bronze"
    />
  );
}

function ArtCard({ item }: { item: ArtworkResult }) {
  const [dl, setDl] = useState<DownloadState>('idle');

  const handleDownload = async () => {
    if (dl === 'fetching') return;
    setDl('fetching');
    try {
      const filename = safeName(item.title, item.artist);
      await downloadViaProxy(item.fullUrl, filename);
      setDl('done');
      setTimeout(() => setDl('idle'), 3500);
    } catch {
      setDl('error');
      setTimeout(() => setDl('idle'), 3000);
    }
  };

  const btnLabel =
    dl === 'fetching'
      ? 'Fetching…'
      : dl === 'done'
        ? 'Saved ✓'
        : dl === 'error'
          ? 'Error — retry?'
          : 'Download full res';

  // Defensively coerce all rendered values to strings
  const safeTitle = typeof item.title === 'string' ? item.title : String(item.title || 'Untitled');
  const safeArtist = typeof item.artist === 'string' ? item.artist : String(item.artist || '');
  const safeDimensions =
    typeof item.dimensions === 'string' && item.dimensions
      ? item.dimensions
      : undefined;

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-line bg-[rgba(16,11,8,.6)] transition hover:-translate-y-0.5 hover:border-bronze/60 hover:shadow-[0_8px_32px_-12px_rgba(216,153,33,.18)]">
      {/* thumbnail */}
      <div className="relative aspect-[4/3] overflow-hidden bg-[rgba(10,8,6,.8)]">
        <img
          src={item.thumbUrl}
          alt={`${safeTitle}${safeArtist ? `, by ${safeArtist}` : ''}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.03]"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
        {!item.isPublicDomain && (
          <span className="absolute left-2 top-2 rounded-sm bg-[rgba(10,8,6,.82)] px-1.5 py-0.5 font-mono text-[.62rem] text-muted">
            © rights may apply
          </span>
        )}
      </div>

      {/* info */}
      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="flex-1 font-display text-[.9rem] font-medium leading-snug text-ink">
            {safeTitle}
          </h3>
          <SourceBadge source={item.source} />
        </div>
        {safeArtist && (
          <p className="text-[.82rem] text-muted">{safeArtist}</p>
        )}
        {safeDimensions && (
          <p className="font-mono text-[.72rem] text-muted/70">
            {safeDimensions}
          </p>
        )}

        <button
          onClick={handleDownload}
          disabled={dl === 'fetching'}
          aria-label={`${btnLabel} — ${safeTitle}`}
          className="mt-auto flex items-center justify-center gap-2 rounded-md border border-line px-3 py-1.5 font-mono text-[.75rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright disabled:cursor-not-allowed disabled:opacity-50"
        >
          {dl === 'fetching' && <Spinner />}
          {btnLabel}
        </button>
      </div>
    </article>
  );
}

function SkeletonCard() {
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-xl border border-line bg-[rgba(16,11,8,.6)]"
    >
      <div className="aspect-[4/3] animate-pulse bg-bronze/10" />
      <div className="space-y-2 p-3.5">
        <div className="h-3 w-3/4 animate-pulse rounded bg-bronze/10" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-bronze/10" />
        <div className="mt-3 h-7 animate-pulse rounded bg-bronze/10" />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ArtGrab() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>({ phase: 'idle' });
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) return;

    setState({ phase: 'loading' });

    // ── IIIF / direct URL path ────────────────────────────────────────────
    if (isURL(q) && IIIF_MANIFEST_RE.test(q)) {
      const result = await resolveIIIF(q);
      if (result) {
        setState({
          phase: 'results',
          items: [result],
          query: q,
          warnings: [],
        });
      } else {
        setState({
          phase: 'error',
          message:
            'Could not resolve a downloadable image from that IIIF URL. ' +
            'Try the Harpe CLI for full tile-stitching support.',
        });
      }
      return;
    }

    // ── Text search via server proxy ──────────────────────────────────────
    try {
      const res = await fetch(`/api/art?q=${encodeURIComponent(q)}`);
      const json: { items?: unknown[]; warnings?: string[]; error?: string } = await res.json();

      if (!res.ok) {
        setState({
          phase: 'error',
          message: json.error ?? `Server error ${res.status}`,
        });
        return;
      }

      const warnings: string[] = Array.isArray(json.warnings) ? json.warnings : [];

      // Normalise each item defensively — the server should already return
      // strings, but we guard every field so no object can ever crash render.
      const items: ArtworkResult[] = (json.items ?? []).map((raw: unknown): ArtworkResult => {
        const d = raw as Record<string, unknown>;
        return {
          id: typeof d.id === 'string' ? d.id : String(d.id ?? ''),
          title: typeof d.title === 'string' ? d.title : String(d.title ?? 'Untitled'),
          artist: typeof d.artist === 'string' ? d.artist : String(d.artist ?? ''),
          dimensions: typeof d.dimensions === 'string' && d.dimensions
            ? d.dimensions
            : undefined,
          thumbUrl: typeof d.thumbUrl === 'string' ? d.thumbUrl : String(d.thumbUrl ?? ''),
          fullUrl: typeof d.fullUrl === 'string' ? d.fullUrl : String(d.fullUrl ?? ''),
          source: (d.source as ArtworkResult['source']) || 'aic',
          isPublicDomain: Boolean(d.isPublicDomain),
        };
      });

      if (items.length === 0 && warnings.length > 0) {
        setState({ phase: 'error', message: warnings.join(' · ') });
      } else {
        setState({ phase: 'results', items, query: q, warnings });
      }
    } catch (e) {
      setState({
        phase: 'error',
        message: e instanceof Error ? e.message : 'Network error',
      });
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    search(query);
  };

  const handleExample = (ex: string) => {
    setQuery(ex);
    inputRef.current?.focus();
    search(ex);
  };

  const EXAMPLES = [
    'The Great Day of His Wrath',
    'Starry Night',
    'The Birth of Venus',
    'Rodin Thinker',
  ];

  return (
    <section
      id="try-it"
      aria-label="Try museum art search"
      className="py-10"
    >
      {/* heading */}
      <div className="mb-10 text-center">
        <span className="mb-3 block font-mono text-[.8rem] tracking-[0.12em] text-bronze">
          ◈ TRY IT — BROWSER EDITION
        </span>
        <h2 className="font-display text-[clamp(1.3rem,3vw,1.9rem)] font-medium">
          Find &amp; download museum art — no install
        </h2>
        <p className="mx-auto mt-3 max-w-[540px] text-[.95rem] text-muted">
          Searches the Art Institute of Chicago, The Met, and Cleveland Museum
          directly from your browser. Public-domain works download as full-resolution
          files. Paste a IIIF URL to grab any zoomable image.
        </p>
      </div>

      {/* search form */}
      <form
        onSubmit={handleSubmit}
        className="mx-auto mb-4 flex max-w-[620px] gap-2"
      >
        <label htmlFor={inputId} className="sr-only">
          Artwork title, artist, or IIIF URL
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="title, artist, or paste a IIIF URL…"
          autoComplete="off"
          spellCheck="false"
          className="flex-1 rounded-md border border-line bg-[rgba(14,10,7,.78)] px-4 py-2.5 font-mono text-[.88rem] text-ink placeholder:text-muted/60 outline-none transition focus:border-bronze/70 focus:ring-1 focus:ring-bronze/30"
        />
        <button
          type="submit"
          disabled={state.phase === 'loading' || !query.trim()}
          className="flex items-center gap-2 rounded-md border border-bronze/45 bg-bronze/10 px-5 py-2.5 font-mono text-[.88rem] text-bronze-bright transition hover:border-bronze hover:bg-bronze/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.phase === 'loading' && <Spinner />}
          Search
        </button>
      </form>

      {/* example chips */}
      <div className="mb-8 flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => handleExample(ex)}
            className="rounded-full border border-line px-3 py-1 font-mono text-[.72rem] text-muted transition hover:border-bronze/60 hover:text-bronze"
          >
            {ex}
          </button>
        ))}
      </div>

      {/* content area */}
      {state.phase === 'idle' && (
        <p className="text-center font-mono text-[.82rem] text-muted/60">
          Search to see results, or paste a IIIF manifest URL to grab a high-res tile.
        </p>
      )}

      {state.phase === 'loading' && (
        <div
          aria-live="polite"
          aria-label="Searching museums"
          className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {state.phase === 'error' && (
        <div
          role="alert"
          className="mx-auto max-w-[540px] rounded-xl border border-line bg-[rgba(16,11,8,.6)] p-6 text-center"
        >
          <span className="mb-2 block font-mono text-2xl text-bronze">⊘</span>
          <p className="text-[.9rem] text-muted">{state.message}</p>
          <p className="mt-3 font-mono text-[.78rem] text-muted/60">
            Need more sources?{' '}
            <a
              href="https://github.com/NullSense/harpe"
              className="text-bronze hover:text-bronze-bright"
            >
              harpe -s &ldquo;{query}&rdquo;
            </a>{' '}
            searches V&amp;A, Wikidata &amp; more.
          </p>
        </div>
      )}

      {state.phase === 'results' && (
        <div aria-live="polite">
          {state.warnings.length > 0 && (
            <p className="mb-4 text-center font-mono text-[.75rem] text-amber/80">
              Partial results — some sources failed: {state.warnings.join(' · ')}
            </p>
          )}

          {state.items.length === 0 ? (
            <div className="mx-auto max-w-[480px] rounded-xl border border-line bg-[rgba(16,11,8,.6)] p-6 text-center">
              <span className="mb-2 block font-mono text-2xl text-bronze">◈</span>
              <p className="text-[.9rem] text-muted">
                No results for &ldquo;{state.query}&rdquo; in the open-access collections.
              </p>
              <p className="mt-3 font-mono text-[.78rem] text-muted/60">
                Try{' '}
                <a
                  href="https://github.com/NullSense/harpe"
                  className="text-bronze hover:text-bronze-bright"
                >
                  harpe -s &ldquo;{state.query}&rdquo;
                </a>{' '}
                for broader coverage.
              </p>
            </div>
          ) : (
            <>
              <p className="mb-4 text-center font-mono text-[.78rem] text-muted/70">
                {state.items.length} work{state.items.length !== 1 ? 's' : ''} found
                {state.items.some((i) => !i.isPublicDomain) &&
                  ' · ⚠ some works may have rights restrictions'}
              </p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
                {state.items.map((item) => (
                  <ArtCard
                    key={item.id}
                    item={item}
                  />
                ))}
              </div>
              <p className="mt-8 text-center font-mono text-[.74rem] text-muted/50">
                Want gigapixel tile-stitching, V&amp;A, Rijksmuseum &amp; 1,800+ other sites?{' '}
                <a
                  href="https://github.com/NullSense/harpe"
                  className="text-bronze hover:text-bronze-bright"
                >
                  Install Harpe →
                </a>
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
