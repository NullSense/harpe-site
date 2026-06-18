/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Resolve @harpe/core and @harpe/sources to their TypeScript source (not the
// built dist) for dev, tests and the client bundle — instant HMR, no build step
// needed locally. The Vercel serverless functions resolve the *built* packages
// via normal node resolution instead (see the build script), which is why both
// packages ship a dist.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));
const sourcesSrc = fileURLToPath(new URL('./packages/sources/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@harpe/core': coreSrc,
      '@harpe/sources': sourcesSrc,
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Vite 8 bundles with Rolldown. Keep this as a function so the React
        // vendor split remains explicit without using the removed object form.
        manualChunks(id: string) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
        },
      },
    },
  },
  // Vitest default = deterministic unit/integration tests. Live API tests are
  // an explicit project so `pnpm test` never discovers them accidentally.
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
          include: ['{src,api}/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          exclude: ['**/*.live.test.ts', 'tests/e2e/**', 'node_modules/**', 'dist/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'live',
          include: ['src/lib/server/handlers/**/*.live.test.ts', 'packages/sources/src/**/*.live.test.ts'],
          exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
        },
      },
    ],
  },
});
