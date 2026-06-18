/**
 * StatsBar — live coverage numbers shown beneath the search box.
 *
 * Seeded with the hardcoded fallback values on first render so there is no
 * layout shift and no empty state. An async fetch from /api/stats refreshes
 * the displayed numbers without causing any visible jump (numbers only
 * increase or stay the same).
 */
import { useEffect, useState } from 'react';

// ─── Seed numbers (matches stats.ts SEED) ───────────────────────────────────
const SEED_ARTWORKS = 50_000_000;
const SEED_MUSEUMS = 3_000;
const SEED_COUNTRIES = 12;

interface StatsData {
  artworks: number;
  museumsAndArchives: number;
  countries: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k+`;
  return `${n}+`;
}

const SEPARATOR = <span aria-hidden className="select-none text-bronze/40">·</span>;

export default function StatsBar() {
  const [stats, setStats] = useState<StatsData>({
    artworks: SEED_ARTWORKS,
    museumsAndArchives: SEED_MUSEUMS,
    countries: SEED_COUNTRIES,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: StatsData | null) => {
        if (cancelled || !data) return;
        if (typeof data.artworks === 'number' && data.artworks > 0) {
          setStats({
            artworks: data.artworks,
            museumsAndArchives:
              typeof data.museumsAndArchives === 'number' && data.museumsAndArchives > 0
                ? data.museumsAndArchives
                : SEED_MUSEUMS,
            countries:
              typeof data.countries === 'number' && data.countries > 0
                ? data.countries
                : SEED_COUNTRIES,
          });
        }
      })
      .catch(() => { /* keep seeds on error */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <p
      aria-label={`Coverage: ${fmt(stats.artworks)} artworks and images across ${fmt(stats.museumsAndArchives)} museums and archives in ${fmt(stats.countries)} countries`}
      className="mt-4 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 font-mono text-[.72rem] tracking-[0.06em] text-muted/70"
    >
      <span>
        <span className="text-bronze-bright/80">{fmt(stats.artworks)}</span>{' '}artworks &amp; images
      </span>
      {SEPARATOR}
      <span>
        <span className="text-bronze-bright/80">{fmt(stats.museumsAndArchives)}</span>{' '}museums &amp; archives
      </span>
      {SEPARATOR}
      <span>
        <span className="text-bronze-bright/80">{fmt(stats.countries)}</span>{' '}countries
      </span>
    </p>
  );
}
