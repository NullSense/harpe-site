/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Resolve @harpe/core to its TypeScript source (not the built dist) for dev,
// tests and the client bundle — instant HMR, no build step needed locally. The
// Vercel serverless functions resolve the *built* package via normal node
// resolution instead (see the build script), which is why core ships a dist.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@harpe/core': coreSrc },
  },
  build: {
    rollupOptions: {
      output: {
        // Vite 8 bundles with rolldown, which only accepts a function here
        // (the object form is a Vite ≤7 / rollup API). Split React into its
        // own long-cached chunk.
        manualChunks(id: string) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
        },
      },
    },
  },
  // Vitest = unit/integration only (*.test.ts). Browser E2E lives in tests/e2e
  // and is run by Playwright (*.spec.ts) — keep the two runners from colliding.
  test: {
    include: ['{src,api}/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
