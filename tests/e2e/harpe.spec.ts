import { test, expect } from '@playwright/test';

// These lock the browser-only regressions we hit this session — the ones unit
// tests can't catch (layout, canvas, stacking context, real downloads).

test('search renders the grid and a card opens the detail viewer', async ({ page }) => {
  await page.goto('/?q=demo');
  await expect(page.locator('img[alt*="Plain Image Demo"]').first()).toBeVisible();
  await page.locator('img[alt*="Plain Image Demo"]').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Plain Image Demo')).toBeVisible();
});

test('an enriched card surfaces the knowledge graph: artist link + depicts pill', async ({ page }) => {
  // The plain-image item carries KG fields (artistId / depicts) — the detail viewer
  // must render the artist as a clickable entity link and the depicts subject pill.
  // Locks the end-to-end payload→UI path for the knowledge graph.
  await page.goto('/?q=demo');
  await page.locator('img[alt*="Plain Image Demo"]').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // artistId present → the artist renders as a button (entity link), not plain text.
  await expect(dialog.getByRole('button', { name: /Test Painter/ })).toBeVisible();
  // depicts label → a subject pill the viewer exposes.
  await expect(dialog.getByText('child')).toBeVisible();
});

test('IIIF deep-zoom renders via the tile proxy (not 1x1, not blank, not ORB-blocked)', async ({ page }) => {
  await page.goto('/?q=demo');
  await page.locator('img[alt*="Deep Zoom Demo"]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // Wait for OpenSeadragon to size its canvas (the container-collapse regression
  // left it at 1x1) and actually PAINT tiles. A successful getImageData readback
  // also proves the canvas is un-tainted (tiles came same-origin via the proxy).
  await page.waitForFunction(() => {
    const c = document.querySelector('[role=dialog] canvas') as HTMLCanvasElement | null;
    if (!c || c.width <= 10 || c.height <= 10) return false;
    try {
      const d = c.getContext('2d')!.getImageData((c.width / 2) | 0, (c.height / 2) | 0, 4, 4).data;
      return [...d].some((v, i) => i % 4 !== 3 && v > 10); // painted + readable (un-tainted)
    } catch { return false; } // tainted → keep waiting → fails loudly on timeout
  }, { timeout: 15_000 });

  const r = await page.evaluate(() => {
    const c = document.querySelector('[role=dialog] canvas') as HTMLCanvasElement;
    return {
      w: c.width, h: c.height,
      proxied: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/tile')).length,
      direct: performance.getEntriesByType('resource').filter((e) => /museum\.test\/iiif/.test(e.name) && !e.name.includes('/api/')).length,
    };
  });

  expect(r.w).toBeGreaterThan(10);          // canvas-collapse fix
  expect(r.h).toBeGreaterThan(10);
  expect(r.proxied).toBeGreaterThan(0);     // tiles routed through /api/tile
  expect(r.direct).toBe(0);                 // no direct museum requests (no ORB)
});

test('the analysis dialog renders on top of the detail viewer', async ({ page }) => {
  await page.goto('/?q=demo');
  await page.locator('img[alt*="Deep Zoom Demo"]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: /Analyse/i }).click();

  await expect(page.getByText('The Subject')).toBeVisible();
  const onTop = await page.evaluate(() => {
    const dlg = [...document.querySelectorAll('[role=dialog]')].find((d) => /Synthesized/i.test(d.getAttribute('aria-label') || ''));
    const top = document.elementFromPoint((innerWidth / 2) | 0, (innerHeight / 2) | 0);
    return !!(dlg && top && dlg.contains(top));
  });
  expect(onTop).toBe(true); // z-index / portal fix
});

test('X/Twitter video post: renders a player and downloads an MP4', async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent('https://x.com/tester/status/123')}`);
  await page.locator('img[alt*="demo video clip"]').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('video')).toBeVisible();

  const download = page.waitForEvent('download', { timeout: 15_000 });
  await dialog.getByRole('button', { name: '1080p', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.mp4$/);
});

test('DZI deep-zoom stitches and downloads a full-resolution image', async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent('http://museum.test/dzi/x.dzi')}`);
  await page.locator('img[alt*="Zoomable image"]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  const download = page.waitForEvent('download', { timeout: 20_000 });
  await page.getByRole('button', { name: /Download full resolution/i }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.jpg$/);
});
