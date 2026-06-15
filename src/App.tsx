import { useEffect, useState, useCallback } from 'react';
import AsciiHero from './AsciiHero.tsx';
import Finder from './Finder.tsx';

// ─── CLI reference data ───────────────────────────────────────────────────────

const INSTALL = 'uv tool install git+https://github.com/NullSense/harpe';

const MODES = [
  ['▰', 'Video & audio', 'yt-dlp under the hood, forced to true max bitrate — 1800+ sites.'],
  ['▦', 'Galleries', "gallery-dl's native extractors for hundreds of sites — originals, not thumbnails."],
  ['⊞', 'Page of images', 'scan any page, rank by real resolution, pick what you want in a visual grid.'],
  ['◈', 'Museum art', 'federated search across 15 open collections — the Met, AIC, Cleveland, V&A, Harvard, Smithsonian, Europeana, Wikidata & more.'],
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

// ─── Power-user tabs (CLI / Extension) ─────────────────────────────────────────

type ToolTab = 'cli' | 'extension';

const TOOL_HASH: Record<string, ToolTab> = { '#cli': 'cli', '#extension': 'extension' };
const toolFromHash = (): ToolTab => TOOL_HASH[window.location.hash.toLowerCase()] ?? 'cli';

function ToolTabs({ active, onSelect }: { active: ToolTab; onSelect: (t: ToolTab) => void }) {
  const tabs: Array<{ id: ToolTab; label: string }> = [
    { id: 'cli', label: 'Terminal (CLI)' },
    { id: 'extension', label: 'Browser extension' },
  ];
  return (
    <div role="tablist" aria-label="Power-user tools" className="flex justify-center gap-2">
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(t.id)}
            className={
              'rounded-full px-4 py-1.5 font-mono text-[.78rem] transition ' +
              (isActive
                ? 'border border-bronze/60 bg-bronze/15 text-bronze-bright'
                : 'border border-line text-muted hover:border-bronze/60 hover:text-ink')
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── CLI panel ────────────────────────────────────────────────────────────────

function CLIPanel() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(INSTALL);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="pt-8">
      <p className="mx-auto mb-8 max-w-[540px] text-center text-[.95rem] text-muted">
        Install once with uv, then pull anything from the terminal. Bare{' '}
        <code className="font-mono text-bronze">harpe</code> is interactive — more than one image opens
        an fzf picker automatically.
      </p>

      {/* install card */}
      <div className="relative mx-auto mb-8 w-[min(640px,100%)] overflow-hidden rounded-xl border border-line bg-[rgba(14,10,7,.78)] text-left backdrop-blur-md shadow-[0_30px_80px_-50px_rgba(216,153,33,.22)]">
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full border border-line" />
          <span className="h-2.5 w-2.5 rounded-full border border-line" />
          <span className="h-2.5 w-2.5 rounded-full border border-line" />
          <span className="ml-2 font-mono text-[.74rem] tracking-[0.08em] text-muted">install</span>
        </div>
        <pre className="overflow-x-auto px-4 py-4 font-mono text-[.86rem] leading-relaxed">
          <code><span className="text-bronze">$</span> {INSTALL}</code>
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
              <tr key={cmd} className={i < CLI_COMMANDS.length - 1 ? 'border-b border-line/50' : ''}>
                <td className="whitespace-nowrap px-4 py-2.5 align-top font-mono text-[.82rem] text-bronze-bright">{cmd}</td>
                <td className="px-4 py-2.5 align-top text-[.85rem] text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* feature cards */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3.5">
        {MODES.map(([g, title, body]) => (
          <article key={title} className="rounded-xl border border-line bg-[rgba(16,11,8,.55)] p-5 transition hover:-translate-y-0.5 hover:border-bronze">
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
    <div className="pt-8">
      <p className="mx-auto mb-10 max-w-[560px] text-center text-[.95rem] text-muted">
        The browser extension runs inside your session — it sees what a server can't:
        JavaScript-rendered galleries, lazy-loaded images, and pages that require you to be logged in.
      </p>

      <div className="mx-auto mb-10 grid max-w-[680px] grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {[
          { g: '⊞', title: 'Full DOM scan', body: 'Scans the rendered DOM after all JavaScript runs — catches lazy-loaded and injected images the web tool misses.' },
          { g: '⌗', title: 'Your session, your images', body: 'Instagram, X, YouTube, paywalled sites — it uses your active login to reach images a headless server never could.' },
          { g: '▰', title: 'Same engine, more reach', body: 'Picks and downloads go through the same Harpe backend — select in a visual grid, download via the proxy.' },
        ].map(({ g, title, body }) => (
          <article key={title} className="rounded-xl border border-line bg-[rgba(16,11,8,.55)] p-5 transition hover:-translate-y-0.5 hover:border-bronze">
            <span className="mb-2 block font-mono text-2xl text-bronze">{g}</span>
            <h3 className="mb-1 font-display text-[1.02rem] font-medium">{title}</h3>
            <p className="text-[.9rem] leading-snug text-muted">{body}</p>
          </article>
        ))}
      </div>

      <div className="mx-auto mb-10 max-w-[640px] rounded-xl border border-line bg-[rgba(14,10,7,.55)] px-5 py-4">
        <p className="font-mono text-[.78rem] leading-relaxed text-muted/80">
          <span className="font-semibold text-muted">Best for:</span> Instagram galleries, X/Twitter media,
          YouTube thumbnails, any auth-walled site, and JS-only image grids.{'  '}
          <span className="font-semibold text-muted">The search box above covers:</span> static pages,
          blogs, museum sites, Wikipedia — no extension needed.
        </p>
      </div>

      <div className="text-center">
        <a href="https://github.com/NullSense/harpe" className="inline-flex items-center gap-2 rounded-md border border-bronze/45 bg-bronze/10 px-5 py-2.5 text-[.95rem] font-medium text-bronze-bright transition hover:border-bronze hover:bg-bronze/20">
          View on GitHub →
        </a>
        <p className="mt-3 font-mono text-[.74rem] text-muted/60">
          Extension repo coming — follow{' '}
          <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">NullSense/harpe</a>{' '}for updates.
        </p>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [toolTab, setToolTab] = useState<ToolTab>(toolFromHash);

  const selectTool = useCallback((t: ToolTab) => {
    history.replaceState(null, '', t === 'cli' ? '#cli' : '#extension');
    setToolTab(t);
  }, []);

  useEffect(() => {
    const onHash = () => setToolTab(toolFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      <AsciiHero />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 60% 52% at 50% 30%, rgba(10,8,6,.82) 0%, rgba(10,8,6,.45) 52%, transparent 78%), radial-gradient(120% 90% at 50% 24%, transparent 0%, rgba(10,8,6,.5) 46%, rgba(10,8,6,.92) 78%, #0a0806 100%), linear-gradient(180deg, rgba(10,8,6,.55), transparent 16% 64%, #0a0806)',
        }}
      />

      <main className="relative z-10 mx-auto max-w-3xl px-5">
        {/* ── Hero: brand + the one search box ── */}
        <section className="pt-[9vh] pb-14">
          <div className="flex flex-col items-center text-center">
            <img
              src="/logo.png"
              alt="Harpe — a bronze hooked sickle-blade with a Greek meander on the hilt"
              className="animate-rise h-[150px] w-auto max-sm:h-[120px]"
              style={{ filter: 'drop-shadow(0 8px 50px rgba(216,153,33,.18))' }}
            />
            <h1 className="sr-only">Harpe</h1>
            <p className="mt-1.5 font-display text-[clamp(1.05rem,2.6vw,1.5rem)] font-medium tracking-[0.04em]">
              A hooked blade for the web — <em className="not-italic text-bronze-bright">enter, catch, retrieve.</em>
            </p>
            <p className="mx-auto mt-3 max-w-[560px] text-[clamp(.92rem,1.6vw,1.02rem)] text-ink/70">
              Pull a whole page of images, or high-res artwork from 15 of the world's open museum
              collections — right here, no install.
            </p>
          </div>

          {/* the one search box + results */}
          <div className="mt-8">
            <Finder />
          </div>

          {/* secondary links */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[.78rem]">
            <a href="https://github.com/NullSense/harpe" className="text-muted transition hover:text-bronze-bright">View on GitHub →</a>
            <a href="https://github.com/NullSense/harpe#readme" className="text-muted transition hover:text-bronze-bright">Read the docs</a>
            <a href="#tools" className="text-muted transition hover:text-bronze-bright">↓ Terminal &amp; extension</a>
          </div>
        </section>

        {/* ── Power users: CLI / Extension ── */}
        <section id="tools" className="mb-20 scroll-mt-6 border-t border-line pt-12">
          <div className="mb-8 text-center">
            <span className="mb-3 block font-mono text-[.8rem] tracking-[0.12em] text-bronze">⌗ GO FURTHER</span>
            <h2 className="font-display text-[clamp(1.3rem,3vw,1.9rem)] font-medium">Prefer the terminal — or your browser?</h2>
            <p className="mx-auto mt-3 max-w-[560px] text-[.95rem] text-muted">
              The search box above handles most pages and museum art. For video, login-walled sites, and
              1,800+ extractors, reach for the CLI or the browser extension.
            </p>
          </div>

          <ToolTabs active={toolTab} onSelect={selectTool} />

          <div role="tabpanel" hidden={toolTab !== 'cli'}>{toolTab === 'cli' && <CLIPanel />}</div>
          <div role="tabpanel" hidden={toolTab !== 'extension'}>{toolTab === 'extension' && <ExtensionPanel />}</div>
        </section>

        <footer className="pb-16 text-center text-muted">
          <p className="mx-auto mb-2 max-w-[600px] text-[.9rem]">
            In Greek myth the <em className="text-bronze">harpe</em> is the sickle-sword of Cronus and
            Perseus — a curved blade that hooks in and severs clean.
          </p>
          <p className="font-mono text-[.76rem] opacity-80">
            MIT ·{' '}
            <a href="https://github.com/NullSense/harpe" className="text-bronze hover:text-bronze-bright">NullSense/harpe</a>{' '}
            · hero: Antonio Canova, <em>Perseus Triumphant</em> — Perseus with the harpe &amp; the head of Medusa, rendered in ASCII
          </p>
        </footer>
      </main>
    </>
  );
}
