/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    include: ['{src,api}/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
