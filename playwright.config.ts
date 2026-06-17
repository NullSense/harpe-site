import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E for Harpe. Tests run against the REAL production build (dist/) served
 * by a dependency-free mock API server (tests/e2e/mock-server.mjs) so they're
 * deterministic and never hit live museum APIs. Run `pnpm run build` first (the
 * webServer serves dist/); CI does this in order.
 */
const PORT = 4310;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['list']]
    : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tests/e2e/mock-server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
