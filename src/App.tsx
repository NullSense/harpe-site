import { useEffect, useRef, useState, useCallback } from 'react';
import AsciiHero from './AsciiHero.tsx';
import ArtGrab from './ArtGrab.tsx';
import WebGrab from './WebGrab.tsx';

// ─── Tab definitions ──────────────────────────────────────────────────────────

type TabId = 'web' | 'art' | 'cli' | 'extension';

interface Tab {
  id: TabId;
  label: string;
  hash: string;
}

const TABS: Tab[] = [
  { id: 'web',       label: 'Web',          hash: '#web' },
  { id: 'art',       label: 'Museum art',   hash: '#art' },
  { id: 'cli',       label: 'CLI',          hash: '#cli' },
  { id: 'extension', label: 'Extension',    hash: '#extension' },
];

const HASH_TO_TAB: Record<string, TabId> = {
  '#web': 'web',
  '#art': 'art',
  '#cli': 'cli',
  '#extension': 'extension',
};

function tabFromHash(): TabId {
  const h = window.location.hash.toLowerCase();
  return HASH_TO_TAB[h] ?? 'web';
}

// ─── CLI reference data ───────────────────────────────────────────────────────

const MODES = [
  ['▰', 'Video & audio', 'yt-dlp under the hood, forced to true max bitrate — 1800+ sites.'],
  ['▦', 'Galleries', "gallery-dl's native extractors for hundreds of sites — originals, not thumbnails."],
  ['⊞', 'Page of images', 'scan any page, rank by real resolution, pick what you want in a visual grid.'],
  ['◈', 'Museum art', 'federated search across AIC, the Met, Cleveland, V&A, Wikidata IIIF & more.'],
  ['⟲', 'Reverse image', 'find the source and the highest-resolution copy — no engine to pick.'],
  ['⌗', 'Frontend-agnostic', 'JSON in, JSON out — drive the engine from a browser extension or a GUI.'],
] as const;

const CLI_COMMANDS = [
  { cmd: 'harpe <url>', desc: 'scan a page and open an image picker' },
  { cmd: 'harpe -p <url>', desc: 'download video/audio at max bitrate via yt-dlp' },
  { cmd: 'harpe -s <query>', desc: 'museum art search — AIC, Met, Cleveland, V&A & more' },
  { cmd: 'harpe -r <file>', desc: 'reverse-image-search a local file' },
  { cmd: 'harpe -v / -A / -a', desc: 'verbosity, all-images, audio-only flags' },
  { cmd: 'harpe', desc: 'bare invocation — interactive mode with fzf picker' },
] as const;

// ─── Typewriter ───────────────────────────────────────────────────────────────

const EXAMPLES = [
  '-p https://any.site/with/images',
  '-s "the great day of his wrath"',
  'https://x.com/i/status/…',
  '-r ./painting.jpg',
  '-a artsandculture.google.com/asset/…',
];

function Typewriter() {
  const [text, setText] = useState('');
  const st = useRef({ i: 0, j: 0, del: false });
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const s = EXAMPLES[st.current.i];
      const { j, del } = st.current;
      setText(del ? s.slice(0, j - 1) : s.slice(0, j + 1));
      st.current.j += del ? -1 : 1;
      let delay = del ? 28 : 55;
      if (!del && st.current.j > s.length) { st.current.del = true; delay = 1700; }
      else if (del && st.current.j < 0) { st.current.del = false; st.current.i = (st.current.i + 1) % EXAMPLES.length; st.current.j = 0; }
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, 600);
    return () => clearTimeout(timer);
  }, []);
  return <span className="text-bronze-bright">{text}</span>;
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

interface TabBarProps {
  active: TabId;
  onSelect: (id: TabId) => void;
}

function TabBar({ active, onSelect }: TabBarProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;

    e.preventDefault();
    tabRefs.current[next]?.focus();
    onSelect(TABS[next].id);
  };

  return (
    <div
      role="tablist"
      aria-label="Harpe features"
      className="flex items-end gap-0 border-b border-line"
    >
      {TABS.map((tab, idx) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={isActive}
            aria-controls={`panel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            ref={(el) => { tabRefs.current[idx] = el; }}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={[
              'relative px-4 py-2.5 font-mono text-[.82rem] tracking-[0.04em] transition-colors',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-bronze/60 focus-visible:outline-offset-2 rounded-t-sm',
              isActive
                ? 'text-bronze-bright'
                : 'text-muted hover:text-ink',
            ].join(' ')}
          >
            {tab.label}
            {/* active indicator — bronze underline flush with the border-b */}
            {isActive && (
              <span
                aria-hidden
                className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t-full bg-bronze"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── CLI panel ────────────────────────────────────────────────────────────────

function CLIPanel({ install }: { install: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(install);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="py-10">
      {/* heading */}
      <div className="mb-10 text-center">
        <span className="mb-3 block font-mono text-[.8rem] tracking-[0.12em] text-bronze">
          ⌗ CLI REFERENCE
        </span>
        <h2 className="font-display text-[clamp(1.3rem,3vw,1.9rem)] font-medium">
          One command, every source
        </h2>
        <p className="mx-auto mt-3 max-w-[540px] text-[.95rem] text-muted">
          Install once with uv, then pull anything from the terminal. Bare{' '}
          <code className="font-mono text-bronze">harpe</code> is interactive —
          more than one image opens an fzf picker automatically.
        </p>
      </div>

      {/* install card */}
      <div className="relative mx-auto mb-8 w-[min(640px,100%)] overflow-hidden rounded-xl border border-line bg-[rgba(14,10,7,.78)] text-left backdrop-blur-md shadow-[0_30px_80px_-50px_rgba(216,153,33,.22)]">
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full border border-line" />
          <span className="h-2.5 w-2.5 rounded-full border border-line" />
          <span className="h-2.5 w-2.5 rounded-full border border-line" />
          <span className="ml-2 font-mono text-[.74rem] tracking-[0.08em] text-muted">install</span>
        </div>
        <pre className="overflow-x-auto px-4 py-4 font-mono text-[.86rem] leading-relaxed">
          <code>
            <span className="text-bronze">$</span> {install}
          </code>
        </pre>
        <button
          onClick={copy}
          className="absolute right-3 top-2.5 cursor-pointer rounded-md border border-line px-2.5 py-1 font-mono text-[.7rem] text-muted transition hover:border-bronze hover:text-bronze-bright"
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
      </div>

      {/* command table */}
      <div className="mx-auto mb-12 w-[min(640px,100%)] overflow-hidden rounded-xl border border-line bg-[rgba(14,10,7,.55)]">
        <div className="border-b border-line px-4 py-2.5">
          <span className="font-mono text-[.74rem] tracking-[0.08em] text-muted">commands</span>
        </div>
        <table className="w-full">
          <tbody>
            {CLI_COMMANDS.map(({ cmd, desc }, i) => (
              <tr
                key={cmd}
                className={i < CLI_COMMANDS.length - 1 ? 'border-b border-line/50' : ''}
              >
                <td className="whitespace-nowrap px-4 py-2.5 align-top font-mono text-[.82rem] text-bronze-bright">
                  {cmd}
                </td>
                <td className="px-4 py-2.5 align-top text-[.85rem] text-muted">
                  {desc}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* feature cards */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3.5">
        {MODES.map(([g, title, body]) => (
          <article
            key={title}
            className="rounded-xl border border-line bg-[rgba(16,11,8,.55)] p-5 transition hover:-translate-y-0.5 hover:border-bronze"
          >
            <span className="mb-2 block font-mono text-2xl text-bronze">{g}</span>
            <h3 className="mb-1 font-display text-[1.02rem] font-medium">{title}</h3>
            <p className="text-[.9rem] leading-snug text-muted">{body}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── Extension panel ──────────────────────────────────────────────────────────

function ExtensionPanel() {
  return (
    <div className="py-10">
      {/* heading */}
      <div className="mb-10 text-center">
        <span className="mb-3 block font-mono text-[.8rem] tracking-[0.12em] text-bronze">
          ⊡ BROWSER EXTENSION
        </span>
        <h2 className="font-display text-[clamp(1.3rem,3vw,1.9rem)] font-medium">
          Reach what the web tool can't
        </h2>
        <p className="mx-auto mt-3 max-w-[560px] text-[.95rem] text-muted">
          The browser extension runs inside your browser session — it sees
          everything the web tool can't: JavaScript-rendered galleries, lazy-loaded
          images, and pages that require you to be logged in.
        </p>
      </div>

      {/* feature cards */}
      <div className="mx-auto mb-10 grid max-w-[680px] grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {[
          {
            g: '⊞',
            title: 'Full DOM scan',
            body: 'Scans the rendered DOM after all JavaScript has run — catches lazy-loaded and dynamically injected images the web tool misses.',
          },
          {
            g: '⌗',
            title: 'Your session, your images',
            body: 'Instagram, X, YouTube, paywalled sites — the extension uses your active login so it can reach images a headless server never could.',
          },
          {
            g: '▰',
            title: 'Same engine, more reach',
            body: 'Picks and downloads go through the same Harpe backend — select images in a visual grid, download via the server proxy.',
          },
        ].map(({ g, title, body }) => (
          <article
            key={title}
            className="rounded-xl border border-line bg-[rgba(16,11,8,.55)] p-5 transition hover:-translate-y-0.5 hover:border-bronze"
          >
            <span className="mb-2 block font-mono text-2xl text-bronze">{g}</span>
            <h3 className="mb-1 font-display text-[1.02rem] font-medium">{title}</h3>
            <p className="text-[.9rem] leading-snug text-muted">{body}</p>
          </article>
        ))}
      </div>

      {/* who it's for */}
      <div className="mx-auto mb-10 max-w-[640px] rounded-xl border border-line bg-[rgba(14,10,7,.55)] px-5 py-4">
        <p className="font-mono text-[.78rem] leading-relaxed text-muted/80">
          <span className="font-semibold text-muted">Best for:</span>{' '}
          Instagram galleries, X/Twitter media, YouTube thumbnails, any auth-walled site,
          and pages that assemble their image grid entirely in JavaScript.
          {'  '}
          <span className="font-semibold text-muted">Web tool covers:</span>{' '}
          static pages, blogs, museum sites, Wikipedia — no extension needed.
        </p>
      </div>

      {/* coming soon + link */}
      <div className="text-center">
        <a
          href="https://github.com/NullSense/harpe"
          className="inline-flex items-center gap-2 rounded-md border border-bronze/45 bg-bronze/10 px-5 py-2.5 text-[.95rem] font-medium text-bronze-bright transition hover:border-bronze hover:bg-bronze/20"
        >
          View on GitHub →
        </a>
        <p className="mt-3 font-mono text-[.74rem] text-muted/60">
          Extension repo coming — follow{' '}
          <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">
            NullSense/harpe
          </a>{' '}
          for updates.
        </p>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash);
  const install = 'uv tool install git+https://github.com/NullSense/harpe';

  const copy = () => {
    navigator.clipboard.writeText(install);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  // Sync hash ↔ active tab
  const selectTab = useCallback((id: TabId) => {
    const tab = TABS.find((t) => t.id === id);
    if (tab) {
      history.replaceState(null, '', tab.hash);
    }
    setActiveTab(id);
  }, []);

  // Handle back/forward navigation
  useEffect(() => {
    const onHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <>
      <AsciiHero />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 60% 52% at 50% 44%, rgba(10,8,6,.82) 0%, rgba(10,8,6,.45) 52%, transparent 78%), radial-gradient(120% 90% at 50% 38%, transparent 0%, rgba(10,8,6,.5) 46%, rgba(10,8,6,.92) 78%, #0a0806 100%), linear-gradient(180deg, rgba(10,8,6,.55), transparent 20% 68%, #0a0806)',
        }}
      />

      <main className="relative z-10 mx-auto max-w-3xl px-5">
        {/* ── Hero section (unchanged) ── */}
        <section className="flex min-h-[100svh] flex-col items-center justify-center py-[7vh] text-center">
          <img
            src="/logo.png"
            alt="Harpe — a bronze hooked sickle-blade with a Greek meander on the hilt"
            className="animate-rise h-[210px] w-auto max-sm:h-[160px]"
            style={{ filter: 'drop-shadow(0 8px 50px rgba(216,153,33,.18))' }}
          />
          <h1 className="sr-only">Harpe</h1>
          <p className="mt-1.5 font-display text-[clamp(1.05rem,2.6vw,1.5rem)] font-medium tracking-[0.04em]">
            A hooked blade for the web — <em className="not-italic text-bronze-bright">enter, catch, retrieve.</em>
          </p>
          <p className="mx-auto mt-4 max-w-[620px] text-[clamp(.96rem,1.7vw,1.08rem)] text-ink/75">
            One command to pull <strong className="font-semibold text-ink">video</strong>,{' '}
            <strong className="font-semibold text-ink">image galleries</strong>, a whole{' '}
            <strong className="font-semibold text-ink">page of images</strong>, or{' '}
            <strong className="font-semibold text-ink">gigapixel artwork</strong> from the world's
            museums. The fzf picker is just one frontend — the engine is yours.
          </p>

          {/* terminal */}
          <div className="relative mt-8 w-[min(640px,100%)] overflow-hidden rounded-xl border border-line bg-[rgba(14,10,7,.78)] text-left backdrop-blur-md shadow-[0_30px_80px_-50px_rgba(216,153,33,.22)]">
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full border border-line" />
              <span className="h-2.5 w-2.5 rounded-full border border-line" />
              <span className="h-2.5 w-2.5 rounded-full border border-line" />
              <span className="ml-2 font-mono text-[.74rem] tracking-[0.08em] text-muted">harpe</span>
            </div>
            <pre className="overflow-x-auto px-4 py-4 font-mono text-[.86rem] leading-relaxed">
              <code>
                <span className="text-bronze">$</span> {install}
                {'\n'}
                <span className="text-bronze">$</span> harpe <Typewriter />
                <span className="caret text-amber">▋</span>
              </code>
            </pre>
            <button
              onClick={copy}
              className="absolute right-3 top-2.5 cursor-pointer rounded-md border border-line px-2.5 py-1 font-mono text-[.7rem] text-muted transition hover:border-bronze hover:text-bronze-bright"
            >
              {copied ? 'copied ✓' : 'copy install'}
            </button>
          </div>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a
              href="https://github.com/NullSense/harpe"
              className="rounded-md border border-bronze/45 bg-bronze/10 px-5 py-2.5 text-[.95rem] font-medium text-bronze-bright transition hover:border-bronze hover:bg-bronze/20"
            >
              View on GitHub →
            </a>
            <a
              href="https://github.com/NullSense/harpe#readme"
              className="rounded-md border border-line px-5 py-2.5 text-[.95rem] font-medium text-muted transition hover:border-bronze/60 hover:text-ink"
            >
              Read the docs
            </a>
          </div>
        </section>

        {/* ── Tabbed interface ── */}
        <div className="mb-20">
          <TabBar active={activeTab} onSelect={selectTab} />

          {/* Web tab */}
          <div
            id="panel-web"
            role="tabpanel"
            aria-labelledby="tab-web"
            hidden={activeTab !== 'web'}
          >
            {activeTab === 'web' && <WebGrab />}
          </div>

          {/* Museum art tab */}
          <div
            id="panel-art"
            role="tabpanel"
            aria-labelledby="tab-art"
            hidden={activeTab !== 'art'}
          >
            {activeTab === 'art' && <ArtGrab />}
          </div>

          {/* CLI tab */}
          <div
            id="panel-cli"
            role="tabpanel"
            aria-labelledby="tab-cli"
            hidden={activeTab !== 'cli'}
          >
            {activeTab === 'cli' && <CLIPanel install={install} />}
          </div>

          {/* Extension tab */}
          <div
            id="panel-extension"
            role="tabpanel"
            aria-labelledby="tab-extension"
            hidden={activeTab !== 'extension'}
          >
            {activeTab === 'extension' && <ExtensionPanel />}
          </div>
        </div>

        <footer className="pb-16 text-center text-muted">
          <p className="mx-auto mb-2 max-w-[600px] text-[.9rem]">
            In Greek myth the <em className="text-bronze">harpe</em> is the sickle-sword of Cronus and
            Perseus — a curved blade that hooks in and severs clean.
          </p>
          <p className="font-mono text-[.76rem] opacity-80">
            MIT ·{' '}
            <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">
              NullSense/harpe
            </a>{' '}
            · hero: Antonio Canova, <em>Perseus Triumphant</em> — Perseus with the harpe &amp; the head of Medusa, rendered in ASCII
          </p>
        </footer>
      </main>
    </>
  );
}
