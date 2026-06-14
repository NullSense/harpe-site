/**
 * DownloadMenu — a bronze-themed "⬇ Download ▾" button with a popover that
 * lets the user pick a format (JPEG / PNG / WebP) and a resolution preset
 * before triggering a server-side converted download via /api/fetch.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
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
  const menuRef = useRef<HTMLDivElement>(null);

  // Prepend screen preset when available (client-side only)
  const [screenRes, setScreenRes] = useState<ResolutionPreset | null>(null);
  useEffect(() => {
    const sp = screenPreset();
    if (sp) setScreenRes(sp);
  }, []);

  const allPresets: ResolutionPreset[] = screenRes
    ? [screenRes, ...RESOLUTION_PRESETS]
    : RESOLUTION_PRESETS;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
    <div ref={menuRef} className="relative inline-block">
      {/* Trigger button */}
      <button
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

      {/* Popover */}
      {open && (
        <div
          role="dialog"
          aria-label="Download options"
          className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded border border-line p-3 shadow-xl"
          style={{ background: 'rgba(16,11,8,.97)' }}
        >
          {/* Format row */}
          <p className="mb-1.5 font-mono text-[.68rem] uppercase tracking-wider text-muted">
            Format
          </p>
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

          {/* Resolution list */}
          <p className="mb-1 font-mono text-[.68rem] uppercase tracking-wider text-muted">
            Resolution
          </p>
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
        </div>
      )}
    </div>
  );
}
