import { useEffect, useRef } from 'react';

/**
 * Live ASCII hero — the Prometheus technique, confirmed by de-minifying their page:
 * Canvas 2D (not WebGL, no library), an image rendered once as ASCII via a
 * luminance→character ramp, kept alive by a *sparse* per-frame twinkle (only a
 * small % of cells re-jitter each frame — their page changes ~0.2–0.5% / 350ms).
 *
 * Source: Antonio Canova, "Perseus Triumphant" — Perseus holding the harpe and the
 * head of Medusa. A brightly-lit marble subject on a dark ground reads cleanly as
 * ASCII (the way Prometheus's lit face does). Rendered in bronze on obsidian with a
 * per-image contrast stretch so the figure is legible. Respects reduced-motion.
 */
const RAMP = ' .:-=+*#%@';
// Crop the source statue before ASCII-ifying: trim the lower portion (Perseus's
// legs/plinth) so the figure sits closer and reads larger/more intensely. Tune
// CROP_BOTTOM upward to zoom in more; CROP_TOP/SIDE trim the other edges.
const CROP_TOP = 0.02;
const CROP_BOTTOM = 0.34;   // drop the bottom third — the legs
const CROP_SIDE = 0.06;     // shave the empty margins so the torso fills more width
const FONT_PX = 12;
const CELL_H = 10;          // < FONT_PX so rows overlap into a dense field (no scanlines)
const CELL_W = 7;
const TWINKLE = 0.006;      // fraction of cells re-jittered per frame
const FPS = 14;

type Cell = { col: number; row: number; b: number };

export default function AsciiHero() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const img = new Image();
    img.src = '/perseus.jpg';

    let cells: Cell[] = [];
    let cols = 0, rows = 0, dpr = 1, raf = 0, last = 0, ready = false;

    const color = (b: number) => {
      const t = Math.min(1, Math.max(0, b));
      return `rgba(${Math.round(130 + t * 125)},${Math.round(75 + t * 115)},${Math.round(30 + t * 80)},${0.3 + t * 0.7})`;
    };
    const charFor = (b: number) => RAMP[Math.min(RAMP.length - 1, Math.floor(b * RAMP.length))];

    const paint = (c: Cell, jitter = 0) => {
      const x = c.col * CELL_W, y = c.row * CELL_H;
      ctx.fillStyle = '#0a0806';
      ctx.fillRect(x, y, CELL_W + 1, CELL_H + 1);
      const b = c.b + jitter;
      if (b <= 0.06) return;          // leave the void empty
      ctx.fillStyle = color(b);
      ctx.fillText(charFor(b), x, y);
    };

    const build = () => {
      const w = canvas.clientWidth || innerWidth;
      const h = canvas.clientHeight || innerHeight;
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.ceil(w / CELL_W);
      rows = Math.ceil(h / CELL_H);

      // contain-fit the figure, centered (subject behind the content, sides empty)
      // — but first crop the source to the upper figure (drop the legs/plinth and
      // shave the side margins) so it reads closer and more intensely than a full
      // contain of the whole statue would.
      const off = document.createElement('canvas');
      off.width = cols; off.height = rows;
      const octx = off.getContext('2d')!;
      octx.fillStyle = '#000'; octx.fillRect(0, 0, cols, rows);
      const sx = img.width * CROP_SIDE;
      const sy = img.height * CROP_TOP;
      const sw = img.width * (1 - CROP_SIDE * 2);
      const sh = img.height * (1 - CROP_TOP - CROP_BOTTOM);
      const ir = sw / sh, gr = cols / rows;
      let dw = cols, dh = rows;
      if (ir > gr) { dh = cols / ir; } else { dw = rows * ir; }
      octx.drawImage(img, sx, sy, sw, sh, (cols - dw) / 2, (rows - dh) / 2, dw, dh);
      const data = octx.getImageData(0, 0, cols, rows).data;

      const lum = new Float32Array(cols * rows);
      for (let i = 0; i < lum.length; i++)
        lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;

      // per-image contrast stretch (2nd–98th percentile) so the marble pops
      const sorted = Float32Array.from(lum).sort();
      const lo = sorted[(sorted.length * 0.02) | 0];
      const hi = sorted[(sorted.length * 0.98) | 0] || 1;
      const span = Math.max(0.001, hi - lo);

      cells = [];
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
          let b = (lum[row * cols + col] - lo) / span;
          b = Math.min(1, Math.max(0, b));
          cells.push({ col, row, b });
        }

      ctx.font = `${FONT_PX}px "IBM Plex Mono", monospace`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#0a0806';
      ctx.fillRect(0, 0, w, h);
      for (const c of cells) paint(c);
      ready = true;
    };

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (!ready || t - last < 1000 / FPS) return;
      last = t;
      const n = Math.max(1, Math.floor(cells.length * TWINKLE));
      for (let k = 0; k < n; k++) {
        const c = cells[(Math.random() * cells.length) | 0];
        paint(c, (Math.random() - 0.4) * 0.5);
      }
    };

    let rt = 0;
    const onResize = () => { clearTimeout(rt); rt = window.setTimeout(build, 160); };
    img.onload = () => {
      build();
      if (!reduce) raf = requestAnimationFrame(frame);
      addEventListener('resize', onResize);
    };

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', onResize);
      clearTimeout(rt);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-20 h-screen w-screen opacity-[0.55]"
    />
  );
}
