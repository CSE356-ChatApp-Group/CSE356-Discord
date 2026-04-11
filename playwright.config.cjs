const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

const frontendDir = path.join(__dirname, 'frontend');

/**
 * Run from monorepo root so APIRequestContext gets baseURL, e.g.
 * E2E_SKIP_WEBSERVER=1 E2E_BASE_URL=http://127.0.0.1:5173 npx playwright test -c playwright.config.cjs e2e/dm-realtime-delivery.spec.ts
 * From frontend/, use the default frontend/playwright.config.ts.
 */
module.exports = defineConfig({
  testDir: path.join(frontendDir, 'e2e'),
  outputDir: path.join(frontendDir, 'test-results'),

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
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
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

  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 5173',
        cwd: frontendDir,
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: true,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 180_000,
      },
});
