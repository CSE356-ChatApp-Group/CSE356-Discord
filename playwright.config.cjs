const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

const frontendDir = path.join(__dirname, 'frontend');

/**
 * Run from monorepo root (same baseURL as staging: nginx :80 + built SPA).
 * Example: npx playwright test -c playwright.config.cjs e2e/dm-realtime-delivery.spec.ts
 * Remote: E2E_BASE_URL=http://your-staging-host npx playwright test -c playwright.config.cjs …
 */
module.exports = defineConfig({
  testDir: path.join(frontendDir, 'e2e'),
  outputDir: path.join(frontendDir, 'test-results'),
  globalSetup: path.join(frontendDir, 'e2e/global-setup.ts'),

  timeout: 60_000,
  globalTimeout: process.env.CI ? 10 * 60_000 : 0,

  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 1,

  reporter: process.env.CI
    ? [['html', { open: 'never', outputFolder: path.join(frontendDir, 'playwright-report') }], ['list']]
    : [['list'], ['html', { open: 'never', outputFolder: path.join(frontendDir, 'playwright-report') }]],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  expect: {
    timeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
