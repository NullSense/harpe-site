import { useEffect, useRef, useState } from 'react';
import AsciiHero from './AsciiHero.tsx';

const EXAMPLES = [
  '-p https://any.site/with/images',
  '-s "the great day of his wrath"',
  'https://x.com/i/status/…',
  '-r ./painting.jpg',
  '-a artsandculture.google.com/asset/…',
];

const MODES = [
  ['▰', 'Video & audio', 'yt-dlp under the hood, forced to true max bitrate — 1800+ sites.'],
  ['▦', 'Galleries', "gallery-dl's native extractors for hundreds of sites — originals, not thumbnails."],
  ['⊞', 'Page of images', 'scan any page, rank by real resolution, pick what you want in a visual grid.'],
  ['◈', 'Museum art', 'federated search across AIC, the Met, Cleveland, V&A, Wikidata IIIF & more.'],
  ['⟲', 'Reverse image', 'find the source and the highest-resolution copy — no engine to pick.'],
  ['⌗', 'Frontend-agnostic', 'JSON in, JSON out — drive the engine from a browser extension or a GUI.'],
] as const;

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

export default function App() {
  const [copied, setCopied] = useState(false);
  const install = 'uv tool install git+https://github.com/NullSense/harpe';
  const copy = () => {
    navigator.clipboard.writeText(install);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <>
      <AsciiHero />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'radial-gradient(120% 90% at 50% 38%, transparent 0%, rgba(10,8,6,.55) 46%, rgba(10,8,6,.92) 78%, #0a0806 100%), linear-gradient(180deg, rgba(10,8,6,.5), transparent 18% 70%, #0a0806)',
        }}
      />

      <main className="relative z-10 mx-auto max-w-3xl px-5">
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
          <p className="mx-auto mt-4 max-w-[620px] text-[clamp(.96rem,1.7vw,1.08rem)] text-muted">
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

        <section className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3.5 pb-20">
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
        </section>

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
