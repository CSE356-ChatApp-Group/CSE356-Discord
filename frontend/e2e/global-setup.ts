import type { FullConfig } from '@playwright/test';

/**
 * One cheap request before the suite: E2E assumes the same layout as staging
 * (nginx on baseURL serving frontend/dist, /api and /ws on the same origin).
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = (config.projects?.[0]?.use?.baseURL as string | undefined)?.replace(/\/$/, '');
  if (!baseURL) return;

  const deadlineMs = 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);

  try {
    const res = await fetch(`${baseURL}/`, { signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} — is E2E_BASE_URL correct?`);
    }
    if (!/id=["']root["']/.test(text)) {
      throw new Error('response is not the ChatApp index (no id="root")');
    }
  } catch (err: unknown) {
    if (err instanceof Error && /E2E_BASE_URL correct|not the ChatApp index/.test(err.message)) {
      throw err;
    }
    const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : '';
    if (name === 'AbortError') {
      throw new Error(
        `Cannot reach ${baseURL} within ${deadlineMs}ms. ` +
          'Local default matches staging: `docker compose up -d`, `cd frontend && npm run build`, ' +
          'then run Playwright (npm scripts run `build` first). ' +
          'For a remote host, set E2E_BASE_URL.',
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/ECONNREFUSED|fetch failed/i.test(msg) || name === 'TypeError') {
      throw new Error(
        `Nothing is accepting HTTP at ${baseURL} (${msg}). ` +
          'Bring up nginx (e.g. docker compose up -d) and build the SPA (`cd frontend && npm run build`).',
      );
    }
    throw new Error(`E2E preflight failed for ${baseURL}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
