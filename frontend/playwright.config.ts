import { defineConfig, devices } from '@playwright/test';

const parsedGlobalMs = Number(process.env.E2E_GLOBAL_TIMEOUT_MS || '');
const globalTimeoutMs =
  Number.isFinite(parsedGlobalMs) && parsedGlobalMs > 0
    ? parsedGlobalMs
    : process.env.CI
      ? 10 * 60_000
      : 0;

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  globalSetup: './e2e/global-setup.ts',

  // Per-test timeout (generous for CI cold starts).
  timeout: 60_000,
  // Whole-run cap (all tests + hooks). Staging @staging/@heavy-auth exceeds 10m — set
  // E2E_GLOBAL_TIMEOUT_MS in CI (e.g. 2100000 = 35m). See package.json e2e:delivery / workflows.
  globalTimeout: globalTimeoutMs,

  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Default 0; `npm run e2e:full` / `e2e:staging:ci` pass `--retries=2` (staging parity).
  retries: 0,
  // Serialize all tests by default — the Docker backend can't handle concurrent
  // auth requests from multiple workers. Set E2E_WORKERS to override locally
  // if you know your stack can handle the load.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 1,

  // Same origin as staging: nginx on baseURL serves frontend/dist; /api and /ws proxied there.
  // Run `docker compose up -d` and `npm run build` (e2e npm scripts run build automatically).
  reporter: process.env.CI
    ? [['html', { open: 'never', outputFolder: 'playwright-report' }], ['list']]
    : [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    // Avoid localhost → ::1; match docker-published nginx on port 80.
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1',
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
      use: {
        ...devices['Desktop Chrome'],
        // Self-hosted CI often has tiny /dev/shm; parallel Chromium tabs OOM without this.
        ...(process.env.CI
          ? {
              launchOptions: {
                args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
              },
            }
          : {}),
      },
    },
  ],
});
