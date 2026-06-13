import { useEffect, useRef } from 'react';

/**
 * Live ASCII hero — the Prometheus technique, confirmed by probing their page:
 * Canvas 2D (not WebGL), an image rendered once as ASCII via a luminance→character
 * ramp, then kept "alive" by a *sparse* per-frame twinkle (only a small % of cells
 * re-jitter each frame — their page changes ~0.2–0.5% of pixels per 350ms).
 *
 * Source image: a public-domain John Martin apocalypse (The Great Day of His Wrath),
 * rendered in bronze on obsidian. Dark cells are left empty so the figure emerges
 * from the void. Respects prefers-reduced-motion (renders one static frame).
 */
const RAMP = ' .·:-=+*о#%@'; // dark → dense
const FONT_PX = 11;          // CSS px per cell row
const CELL_ASPECT = 0.58;    // monospace glyph width / height
const TWINKLE = 0.006;       // fraction of cells re-jittered per frame
const FPS = 14;

type Cell = { col: number; row: number; b: number }; // base brightness 0..1

export default function AsciiHero() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const img = new Image();
    img.src = '/martin.jpg';

    let cells: Cell[] = [];
    let cols = 0, rows = 0, cellW = 0, cellH = 0, dpr = 1;
    let raf = 0, last = 0, ready = false;

    // bronze gradient by brightness: dim oxidized bronze → bright amber/ivory
    const color = (b: number, jitter = 0) => {
      const t = Math.min(1, Math.max(0, b + jitter));
      const r = Math.round(120 + t * 120);
      const g = Math.round(70 + t * 115);
      const bl = Math.round(28 + t * 78);
      const a = 0.28 + t * 0.72;
      return `rgba(${r},${g},${bl},${a})`;
    };
    const charFor = (b: number) =>
      RAMP[Math.min(RAMP.length - 1, Math.floor(b * RAMP.length))];

    const paintCell = (c: Cell, jitter = 0) => {
      const x = c.col * cellW;
      const y = c.row * cellH;
      ctx.fillStyle = '#0a0806';
      ctx.fillRect(x, y, cellW + 1, cellH + 1);
      const b = c.b + jitter;
      if (b <= 0.12) return; // leave the void empty
      ctx.fillStyle = color(b, 0);
      ctx.fillText(charFor(b), x, y);
    };

    const build = () => {
      const w = (canvas.clientWidth || innerWidth);
      const h = (canvas.clientHeight || innerHeight);
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cellH = FONT_PX;
      cellW = Math.max(4, Math.round(FONT_PX * CELL_ASPECT));
      cols = Math.ceil(w / cellW);
      rows = Math.ceil(h / cellH);

      // sample the image at grid resolution (cover-fit), read luminance per cell
      const off = document.createElement('canvas');
      off.width = cols; off.height = rows;
      const octx = off.getContext('2d')!;
      const ir = img.width / img.height, gr = cols / rows;
      let dw = cols, dh = rows, dx = 0, dy = 0;
      if (ir > gr) { dw = rows * ir; dx = (cols - dw) / 2; }
      else { dh = cols / ir; dy = (rows - dh) / 2; }
      octx.fillStyle = '#000'; octx.fillRect(0, 0, cols, rows);
      octx.drawImage(img, dx, dy, dw, dh);
      const data = octx.getImageData(0, 0, cols, rows).data;

      cells = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = (row * cols + col) * 4;
          let b = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
          b = Math.pow(b, 0.85);            // gentle contrast lift
          cells.push({ col, row, b });
        }
      }

      ctx.font = `${FONT_PX}px "IBM Plex Mono", monospace`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#0a0806';
      ctx.fillRect(0, 0, w, h);
      for (const c of cells) paintCell(c);
      ready = true;
    };

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (!ready || t - last < 1000 / FPS) return;
      last = t;
      const n = Math.max(1, Math.floor(cells.length * TWINKLE));
      for (let k = 0; k < n; k++) {
        const c = cells[(Math.random() * cells.length) | 0];
        paintCell(c, (Math.random() - 0.4) * 0.5); // brief brighten/dim
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
      className="pointer-events-none fixed inset-0 -z-10 h-screen w-screen opacity-55"
    />
  );
}
