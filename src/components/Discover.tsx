/**
 * Discover — the search box's empty state.
 *
 * Before the first search there's nothing to show, so give visitors curated
 * entry points: iconic artists, movements and themes as clickable chips. Each
 * chip just runs the normal federated search, so the reward is real streamed
 * results — no images to host or keep from rotting here.
 */
import { useMemo } from 'react';
import {
  FEATURED_ARTISTS, FEATURED_MOVEMENTS, FEATURED_THEMES, ARTISTS, type Suggestion,
} from '../lib/discover';

interface Props {
  onPick: (query: string) => void;
}

function Chips({ items, onPick }: { items: Suggestion[]; onPick: (q: string) => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((s) => (
        <button
          key={`${s.kind}:${s.query}`}
          type="button"
          onClick={() => onPick(s.query)}
          title={s.hint}
          className="rounded-full border border-line px-3 py-1.5 text-[.8rem] text-muted transition hover:border-bronze/60 hover:text-bronze-bright"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2.5 text-center font-mono text-[.68rem] uppercase tracking-[0.14em] text-muted/60">
        {title}
      </h3>
      {children}
    </div>
  );
}

export default function Discover({ onPick }: Props) {
  // "Surprise me" — a deterministic-per-render pick is fine; it varies across
  // renders as the list/state changes, and a fresh one is one click away.
  const surprise = useMemo(() => {
    const i = Math.floor(Math.random() * ARTISTS.length);
    return ARTISTS[i];
  }, []);

  return (
    <div className="mx-auto max-w-[680px]">
      <div className="flex flex-col gap-7">
        <Section title="Popular artists">
          <Chips items={FEATURED_ARTISTS} onPick={onPick} />
        </Section>
        <Section title="Movements">
          <Chips items={FEATURED_MOVEMENTS} onPick={onPick} />
        </Section>
        <Section title="Themes">
          <Chips items={FEATURED_THEMES} onPick={onPick} />
        </Section>
      </div>

      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={() => onPick(surprise.query)}
          className="rounded-full border border-bronze/45 bg-bronze/10 px-5 py-2 text-[.84rem] font-medium text-bronze-bright transition hover:border-bronze hover:bg-bronze/20"
        >
          ✦ Surprise me
        </button>
      </div>
    </div>
  );
}
