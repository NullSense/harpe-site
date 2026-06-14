/**
 * Automated demo recorder for the Harpe web tool — no manual screen-recording.
 *
 * Playwright drives the live site and records video natively, so you get real
 * image previews, deterministic timing, and a re-runnable script.
 *
 * Run:
 *   npx playwright@latest install chromium      # one-time
 *   node demo/record-web.mjs                    # → demo/video/*.webm
 *   # convert (ffmpeg):
 *   ffmpeg -i demo/video/*.webm -vf "fps=30,scale=1280:-1:flags=lanczos" demo/web.gif
 *   ffmpeg -i demo/video/*.webm -movflags +faststart -pix_fmt yuv420p demo/web.mp4
 *
 * Override the target:  SITE=http://localhost:3000 node demo/record-web.mjs
 */
import { chromium } from 'playwright';

const SITE = process.env.SITE || 'https://harpe-site.vercel.app';
const W = 1280, H = 800;
const wait = (p, ms) => p.waitForTimeout(ms);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  recordVideo: { dir: 'demo/video', size: { width: W, height: H } },
});
const page = await ctx.newPage();

// 1) Land on the hero (Web tab is default)
await page.goto(SITE, { waitUntil: 'networkidle' });
await wait(page, 1200);

// 2) Scroll to the "paste a URL" tool
await page.evaluate(() => document.querySelector('input[type=url]')?.scrollIntoView({ block: 'center' }));
await wait(page, 600);

// 3) Type a page URL (Perseus — on brand) and find its images
const url = 'https://en.wikipedia.org/wiki/Perseus';
const input = page.locator('input[type=url]').first();
await input.click();
await input.pressSequentially(url, { delay: 35 });
await wait(page, 400);
await page.getByRole('button', { name: /find images/i }).click();

// 4) Wait for the real image grid to populate (server scan + thumbnails)
await page.waitForSelector('article', { timeout: 30000 });
await wait(page, 2500);

// 5) Show multi-select
const selectAll = page.getByRole('button', { name: /select all/i });
if (await selectAll.count()) { await selectAll.click(); await wait(page, 1800); }

// 6) Hold on the result
await wait(page, 1500);

await ctx.close();   // flushes the video file
await browser.close();
console.log('Recorded → demo/video/  (convert with the ffmpeg lines in this file)');
