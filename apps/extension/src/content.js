/**
 * Harpe content script — scans the RENDERED DOM for images.
 *
 * Runs in the page's context so it sees:
 *   • JS-injected / lazy-loaded images already in the DOM
 *   • The user's authenticated session (cookies, auth headers already sent)
 *
 * Sources scanned:
 *   1. <img> — src, srcset, and lazy-load attrs
 *   2. <picture><source> — srcset / data-srcset
 *   3. CSS background-image (computed style on visible elements)
 *   4. <link rel="preload" as="image">
 *   5. <meta> og:image / twitter:image
 *   6. <a href> pointing at image extensions
 *
 * Resolves all URLs to absolute, deduplicates, reads naturalWidth/Height
 * where available, probes unknown-dimension images with a hidden Image load,
 * ranks by pixel area, and drops icons smaller than MIN_LONG_EDGE — but
 * relaxes that floor if it would otherwise produce an empty set.
 */

(() => {
  "use strict";

  // This script is registered statically (content_scripts) AND re-injected on
  // demand (chrome.scripting.executeScript in handleScan, for tabs opened before
  // install). Guard so we don't stack a second message listener on re-injection.
  if (window.__harpeContentLoaded) return;
  window.__harpeContentLoaded = true;

  const MIN_LONG_EDGE = 100; // px — drop likely icons/spacers
  // Perf budgets: probing loads the actual image to read its size, so cap how
  // many we fetch and how many run at once; cap the background-image DOM walk too.
  const PROBE_CAP = 80;        // max images network-probed for dimensions
  const PROBE_CONCURRENCY = 6; // simultaneous probe loads
  const MAX_BG_NODES = 2500;   // elements scanned for CSS background-image
  const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico)(\?.*)?$/i;
  const LAZY_ATTRS = [
    "data-src",
    "data-lazy-src",
    "data-lazy",
    "data-original",
    "data-srcset",
    "data-lazy-srcset",
    "data-echo",
    "data-url",
  ];

  /** Resolve a possibly-relative URL against the document base. */
  function abs(url) {
    if (!url || typeof url !== "string") return null;
    url = url.trim();
    if (!url || url.startsWith("data:") || url.startsWith("blob:"))
      return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return null;
    }
  }

  /** Parse a srcset string, return array of absolute URLs (largest first). */
  function parseSrcset(srcset) {
    if (!srcset) return [];
    return srcset
      .split(",")
      .map((part) => {
        const [url] = part.trim().split(/\s+/);
        return abs(url);
      })
      .filter(Boolean);
  }

  /** Extract URLs from a CSS background-image value. */
  function parseBgImage(val) {
    if (!val) return [];
    const urls = [];
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let m;
    while ((m = re.exec(val)) !== null) {
      const u = abs(m[2]);
      if (u) urls.push(u);
    }
    return urls;
  }

  /** Collect all candidate URLs from the live DOM. */
  function collectCandidates() {
    const seen = new Set();
    const candidates = []; // { url, el? }

    function add(url, el) {
      if (!url) return;
      if (seen.has(url)) return;
      seen.add(url);
      candidates.push({ url, el: el || null });
    }

    // 1. <img> elements
    for (const img of document.querySelectorAll("img")) {
      if (img.src) add(abs(img.src), img);
      for (const u of parseSrcset(img.srcset)) add(u, img);
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) {
          if (attr.includes("srcset")) {
            for (const u of parseSrcset(v)) add(u, img);
          } else {
            add(abs(v), img);
          }
        }
      }
    }

    // 2. <picture><source>
    for (const src of document.querySelectorAll("picture source")) {
      for (const u of parseSrcset(
        src.srcset || src.getAttribute("data-srcset")
      ))
        add(u, src);
    }

    // 3. CSS background-image — getComputedStyle is the costly part, so cap how
    //    many elements we inspect (huge pages have tens of thousands of nodes).
    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_ELEMENT
    );
    let node;
    let bgScanned = 0;
    while ((node = walker.nextNode()) && bgScanned < MAX_BG_NODES) {
      bgScanned++;
      try {
        const style = window.getComputedStyle(node);
        const bg = style.backgroundImage;
        if (bg && bg !== "none") {
          for (const u of parseBgImage(bg)) add(u, node);
        }
      } catch {
        /* cross-origin frame element — skip */
      }
    }

    // 4. <link rel="preload" as="image">
    for (const link of document.querySelectorAll(
      'link[rel="preload"][as="image"]'
    )) {
      if (link.href) add(abs(link.href), link);
      if (link.imageSrcset) {
        for (const u of parseSrcset(link.imageSrcset)) add(u, link);
      }
    }

    // 5. <meta> og/twitter image
    for (const meta of document.querySelectorAll(
      'meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]'
    )) {
      add(abs(meta.content), null);
    }

    // 6. <a href> pointing at image extensions
    for (const a of document.querySelectorAll("a[href]")) {
      const u = abs(a.href);
      if (u && IMAGE_EXTS.test(u)) add(u, a);
    }

    return candidates;
  }

  /** Read dimensions from an already-loaded <img> element. */
  function dimsFromEl(el) {
    if (el && el.tagName === "IMG") {
      const w = el.naturalWidth;
      const h = el.naturalHeight;
      if (w > 0 && h > 0) return { w, h };
    }
    return null;
  }

  /** Probe an image URL to get its natural dimensions. */
  function probeDims(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const done = (w, h) => resolve({ w, h });
      img.onload = () => done(img.naturalWidth, img.naturalHeight);
      img.onerror = () => done(0, 0);
      img.src = url;
      // Bail after 4 s so we don't hang forever on slow/dead images
      setTimeout(() => done(0, 0), 4000);
    });
  }

  // Run async tasks with bounded concurrency (avoids opening hundreds of image
  // connections at once on media-heavy pages).
  async function pooled(items, limit, worker) {
    const out = new Array(items.length);
    let i = 0;
    async function lane() {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
    return out;
  }

  async function run() {
    const candidates = collectCandidates();

    // Cheap pass: dimensions already known from the rendered <img> element.
    const known = [];
    const needProbe = [];
    for (const c of candidates) {
      const dims = dimsFromEl(c.el);
      if (dims) known.push({ url: c.url, ...dims });
      else needProbe.push(c);
    }

    // Costly pass: probing fetches the image, so cap the count + concurrency.
    // Anything beyond the cap is kept with unknown size (sorts last, not dropped).
    const probeList = needProbe.slice(0, PROBE_CAP);
    const overflow = needProbe.slice(PROBE_CAP);
    const probed = await pooled(probeList, PROBE_CONCURRENCY, async ({ url }) => {
      const dims = await probeDims(url);
      return { url, w: dims.w, h: dims.h };
    });

    const withDims = [...known, ...probed, ...overflow.map((c) => ({ url: c.url, w: 0, h: 0 }))]
      .map((d) => ({ ...d, area: d.w * d.h, longEdge: Math.max(d.w, d.h) }));

    // Sort by area descending
    withDims.sort((a, b) => b.area - a.area);

    // Filter tiny images, but relax the floor if it would empty the list
    let filtered = withDims.filter((i) => i.longEdge >= MIN_LONG_EDGE);
    if (filtered.length === 0) {
      // Relax: take anything with a non-zero size, or everything if all are 0
      filtered = withDims.filter((i) => i.area > 0);
      if (filtered.length === 0) filtered = withDims;
    }

    // Direct <video> sources (skip blob:/MSE — those, like X's player, aren't a
    // plain file; X video is resolved from its tweet id in the background).
    const videos = [];
    for (const v of document.querySelectorAll("video")) {
      const cand = [v.currentSrc, v.getAttribute("src"),
        ...[...v.querySelectorAll("source")].map((s) => s.getAttribute("src"))];
      const url = cand.map(abs).find(Boolean);
      if (url) {
        videos.push({
          url, kind: "video", poster: abs(v.poster) || null,
          w: v.videoWidth || 0, h: v.videoHeight || 0,
          area: (v.videoWidth || 0) * (v.videoHeight || 0),
        });
      }
    }

    // X / Twitter post id → the background resolves its MP4s via the public
    // syndication API (the video lives behind an MSE blob, not in the DOM).
    let tweetId = null;
    try {
      if (/(^|\.)(twitter|x)\.com$/i.test(location.hostname)) {
        const m = /\/status(?:es)?\/(\d+)/.exec(location.pathname);
        if (m) tweetId = m[1];
      }
    } catch { /* ignore */ }

    return {
      images: filtered.map(({ url, w, h, area }) => ({ url, w, h, area })),
      videos,
      tweetId,
      pageUrl: document.location.href,
      pageTitle: document.title,
    };
  }

  // Listen for scan request from background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "HARPE_SCAN") return false;
    run()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  });
})();
