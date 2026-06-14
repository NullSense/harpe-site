/**
 * DownloadMenu — a bronze-themed "⬇ Download ▾" button with a popover that
 * lets the user pick a format (JPEG / PNG / WebP) and a resolution preset
 * before triggering a server-side converted download via /api/fetch.
 *
 * The popover is rendered in a PORTAL (document.body, position: fixed) so it is
 * never clipped by an ancestor's `overflow-hidden` (e.g. the masonry card) and
 * always paints above the grid. Position is computed from the trigger's rect.
 */

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { FORMATS, RESOLUTION_PRESETS, screenPreset, buildFetchUrl } from '../lib/resolutions';
import type { ResolutionPreset } from '../lib/resolutions';
import { safeName } from '../lib/media';

export interface DownloadMenuProps {
  fullUrl: string;
  title: string;
  artist?: string;
}

export default function DownloadMenu({ fullUrl, title, artist }: DownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const [fmt, setFmt] = useState('jpeg');
  const [downloading, setDownloading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const [screenRes, setScreenRes] = useState<ResolutionPreset | null>(null);
  useEffect(() => {
    const sp = screenPreset();
    if (sp) setScreenRes(sp);
  }, []);

  const allPresets: ResolutionPreset[] = screenRes
    ? [screenRes, ...RESOLUTION_PRESETS]
    : RESOLUTION_PRESETS;

  // Position the portal popover under the trigger (right-aligned), clamped to the
  // viewport. Recomputed on open and on scroll/resize.
  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const W = 224; // w-56
    const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
    const top = Math.min(r.bottom + 6, window.innerHeight - 8);
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const tgt = e.target as Node;
      if (popRef.current?.contains(tgt) || triggerRef.current?.contains(tgt)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleDownload = useCallback(
    async (preset: ResolutionPreset) => {
      setOpen(false);
      setDownloading(true);
      try {
        const proxyUrl = buildFetchUrl(fullUrl, { longEdge: preset.longEdge ?? undefined, fmt });
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const filename = safeName(title, artist ?? '', ext);
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
      } catch (err) {
        console.error('[DownloadMenu] download failed', err);
      } finally {
        setDownloading(false);
      }
    },
    [fullUrl, fmt, title, artist],
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        disabled={downloading}
        onClick={() => setOpen((v) => !v)}
        className={
          'flex items-center gap-1.5 rounded border px-3 py-1.5 font-mono text-[.78rem] transition ' +
          (downloading
            ? 'cursor-wait border-line text-muted'
            : 'border-bronze/60 bg-bronze/10 text-bronze-bright hover:bg-bronze/20')
        }
      >
        {downloading ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-bronze/40 border-t-bronze" />
            Fetching…
          </>
        ) : (
          <>⬇ Download ▾</>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Download options"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 224, background: 'rgba(16,11,8,.98)' }}
          className="z-[80] rounded border border-line p-3 shadow-2xl"
        >
          <p className="mb-1.5 font-mono text-[.68rem] uppercase tracking-wider text-muted">Format</p>
          <div className="mb-3 flex flex-wrap gap-1">
            {FORMATS.map((f) => (
              <button
                key={f.fmt}
                type="button"
                onClick={() => setFmt(f.fmt)}
                className={
                  'rounded px-2 py-0.5 font-mono text-[.72rem] transition ' +
                  (fmt === f.fmt
                    ? 'border border-bronze/60 bg-bronze/15 text-bronze-bright'
                    : 'border border-line text-muted hover:border-bronze/40 hover:text-ink')
                }
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="mb-1 font-mono text-[.68rem] uppercase tracking-wider text-muted">Resolution</p>
          <ul className="space-y-0.5">
            {allPresets.map((preset) => (
              <li key={preset.label}>
                <button
                  type="button"
                  onClick={() => handleDownload(preset)}
                  className="w-full rounded px-2 py-1 text-left font-mono text-[.78rem] text-ink transition hover:bg-bronze/10 hover:text-bronze-bright"
                >
                  {preset.label}
                </button>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
