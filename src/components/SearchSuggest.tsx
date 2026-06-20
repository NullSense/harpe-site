/**
 * SearchSuggest — the search box's autocomplete combobox.
 *
 * Implements the W3C ARIA APG "editable combobox with list autocomplete" pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/):
 * DOM focus stays on the input; the active option is tracked with
 * aria-activedescendant; full keyboard contract (↓ ↑ Home End Enter Esc Tab).
 * Built by hand to keep the app dependency-free — the suggestion pool is a small
 * static list, so no headless-combobox library is warranted.
 *
 * It owns the <input> (so it can wire the combobox a11y + key handling) but the
 * surrounding <form> and submit button stay in Finder: pressing Enter with no
 * active option falls through to the form's normal submit.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { suggest, loadSuggestions, type Suggestion, type SuggestKind } from '../lib/discover';

const KIND_ICON: Record<SuggestKind, string> = { artist: '◔', movement: '❖', theme: '✦', subject: '◇' };
const KIND_LABEL: Record<SuggestKind, string> = { artist: 'Artist', movement: 'Movement', theme: 'Theme', subject: 'Subject' };

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Run a search for this query (suggestion picked, or a name confirmed). The picked
   *  Suggestion is passed when one was chosen, so a KG-backed pick (with a qid) can
   *  open the entity card directly instead of round-tripping through /api/resolve. */
  onPick: (query: string, picked?: Suggestion) => void;
  /** Off for URL-looking input — we don't autocomplete links. */
  enabled: boolean;
  /** Clear the box and return to the home/discovery state (shows a ✕ when set). */
  onClear?: () => void;
  inputId: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  className: string;
  disabled?: boolean;
}

export default function SearchSuggest({
  value, onChange, onPick, enabled, onClear, inputId, inputRef, placeholder, className, disabled,
}: Props) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1); // index into `items`, -1 = input itself
  const [focused, setFocused] = useState(false);

  const items = useMemo<Suggestion[]>(
    () => (enabled && value.trim() ? suggest(value) : []),
    [enabled, value],
  );

  const show = open && focused && items.length > 0;

  // Reset the highlight whenever the suggestion set changes (new keystroke).
  useEffect(() => { setActive(-1); }, [value, enabled]);

  // Upgrade the static fallback pool to the KG-derived one (once, lazily).
  useEffect(() => { void loadSuggestions(); }, []);

  // Keep the active option scrolled into view (aria-activedescendant doesn't do
  // this for us — APG note 3 on the combobox examples).
  useEffect(() => {
    if (!show || active < 0) return;
    document.getElementById(`${listboxId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, show, listboxId]);

  const pick = (s: Suggestion) => {
    onChange(s.query);
    setOpen(false);
    setActive(-1);
    onPick(s.query, s);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!show) { setOpen(true); setActive(items.length ? 0 : -1); return; }
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!show) { setOpen(true); setActive(items.length - 1); return; }
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === 'Home' && show) {
      e.preventDefault(); setActive(0);
    } else if (e.key === 'End' && show) {
      e.preventDefault(); setActive(items.length - 1);
    } else if (e.key === 'Enter') {
      if (show && active >= 0) { e.preventDefault(); pick(items[active]); } // else: form submits
    } else if (e.key === 'Escape') {
      if (show) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); }
    } else if (e.key === 'Tab') {
      setOpen(false); setActive(-1); // accept what's typed, move on
    }
  };

  const activeId = show && active >= 0 ? `${listboxId}-opt-${active}` : undefined;

  return (
    <div className="relative flex-1">
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        inputMode="url"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => { setFocused(true); setOpen(true); }}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck="false"
        disabled={disabled}
        role="combobox"
        aria-expanded={show}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        className={className}
      />

      {onClear && value.length > 0 && (
        <button
          type="button"
          onClick={() => { onClear(); setOpen(false); setActive(-1); inputRef.current?.focus(); }}
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted transition hover:bg-bronze/15 hover:text-bronze-bright"
        >
          <span aria-hidden className="text-[1.05rem] leading-none">×</span>
        </button>
      )}

      {show && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[min(56vh,420px)] overflow-auto rounded-lg border border-line bg-[rgba(18,13,9,.98)] py-1 shadow-[0_12px_40px_rgba(0,0,0,.5)] backdrop-blur-sm"
        >
          {items.map((s, i) => (
            <li
              key={`${s.kind}:${s.query}`}
              id={`${listboxId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              // preventDefault on mousedown so the input doesn't blur before click
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-left ${
                i === active ? 'bg-bronze/20' : ''
              }`}
            >
              <span aria-hidden className="w-4 shrink-0 text-center font-mono text-[.8rem] text-bronze/70">
                {KIND_ICON[s.kind]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[.9rem] text-ink">{s.label}</span>
                <span className="block truncate text-[.72rem] text-muted">{s.hint}</span>
              </span>
              <span className="shrink-0 font-mono text-[.62rem] uppercase tracking-[0.08em] text-muted/55">
                {KIND_LABEL[s.kind]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
