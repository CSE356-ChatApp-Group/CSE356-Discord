import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',

  // Per-test timeout (generous for CI cold starts).
  timeout: 60_000,
  // Timeout for beforeAll / afterAll hooks shared across tests.
  globalTimeout: process.env.CI ? 10 * 60_000 : 0,

  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Keep retries at zero so any instability is surfaced immediately.
  retries: 0,
  // Serialize all tests by default — the Docker backend can't handle concurrent
  // auth requests from multiple workers. Set E2E_WORKERS to override locally
  // if you know your stack can handle the load.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 1,

  reporter: process.env.CI
    ? [['html', { open: 'never', outputFolder: 'playwright-report' }], ['list']]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Default navigation / action timeout.
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
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
