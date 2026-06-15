#!/usr/bin/env node
/**
 * Verify every Vercel serverless function bundles cleanly.
 *
 * Our api/*.ts handlers import shared code from src/lib/* (cross-directory). That
 * compiles under tsc but would 500 at runtime if Vercel's bundler couldn't resolve
 * it — a class of failure typecheck cannot catch. This reproduces the bundle step
 * with esbuild (already a transitive dependency of Vite — no new deps) and fails
 * CI if any function's import graph is broken.
 */
import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';

const entries = (await readdir('api')).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && f !== '_vercel.ts',
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
process.exit(failed ? 1 : 0);
