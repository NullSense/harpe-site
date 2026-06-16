#!/usr/bin/env node
/**
 * Verify every Vercel serverless function bundles cleanly.
 *
 * Our api/*.ts handlers import shared code from src/lib/* (cross-directory). That
 * compiles under tsc but would 500 at runtime if Vercel's bundler couldn't resolve
 * it — a class of failure typecheck cannot catch. This reproduces the bundle step
 * with esbuild (already a transitive dependency of Vite — no new deps) and fails
 * CI if any function's import graph is broken.
 *
 * It ALSO enforces the Vercel Hobby ceiling of 12 Serverless Functions. The API
 * is now a single catch-all (api/[...path].ts) dispatching to handler modules in
 * src/lib/server/handlers, so the count is 1 — but the guard stays as a backstop:
 * exceeding 12 makes the *deploy* (not the build) fail and silently freezes prod
 * on the last good deploy, which is exactly how /api/x went missing once.
 */
import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';

const FUNCTION_LIMIT = 12; // Vercel Hobby plan

const entries = (await readdir('api')).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
);

let failed = 0;
for (const f of entries) {
  try {
    await build({
      entryPoints: [`api/${f}`],
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external', // only resolve the LOCAL import graph, not node_modules
      write: false,
      logLevel: 'silent',
    });
    console.log(`  ok   api/${f}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL api/${f}\n${e.message}`);
  }
}
console.log(failed ? `\n✗ ${failed} function(s) failed to bundle` : `\n✓ all ${entries.length} functions bundle cleanly`);

if (entries.length > FUNCTION_LIMIT) {
  console.error(`\n✗ ${entries.length} serverless functions — exceeds the Vercel Hobby limit of ${FUNCTION_LIMIT}.\n  Move shared helpers OUT of api/ (into lib/ or src/lib/) so they're bundled, not counted.`);
  process.exit(1);
}
console.log(`  (${entries.length}/${FUNCTION_LIMIT} serverless functions)`);
process.exit(failed ? 1 : 0);
