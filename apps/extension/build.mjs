/**
 * Build the loadable/zippable extension into dist/.
 *
 * Bundles the three entry scripts with esbuild (classic IIFE — the MV3 service
 * worker and content script stay plain scripts, so the manifest is unchanged),
 * resolving @harpe/core from its TS source. Then copies the static assets
 * (manifest, html, css, icons) over. Load dist/ as the unpacked extension.
 */
import { build } from 'esbuild';
import { cp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here('./dist');
const coreSrc = here('../../packages/core/src/index.ts');

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/js`, { recursive: true });

await build({
  entryPoints: [here('./src/background.js'), here('./src/content.js'), here('./src/popup.js')],
  outdir: `${dist}/js`,
  bundle: true,
  format: 'iife', // classic scripts → manifest needs no "type":"module"
  target: 'chrome116',
  alias: { '@harpe/core': coreSrc },
  legalComments: 'none',
  logLevel: 'info',
});

// Static assets sit at the dist root, mirroring the manifest's relative paths.
await cp(here('./static'), dist, { recursive: true });
console.log('✓ extension built → apps/extension/dist (load this unpacked)');
