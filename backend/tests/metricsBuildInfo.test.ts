/**
 * Build-info metric (chatapp_build_info) regression test.
 *
 * Locks in the contract that `backend/src/utils/metrics.ts` registers a single
 * Gauge named `chatapp_build_info` at module load with low-cardinality labels
 * `sha` and `version`, value 1, sourced from
 *
 *   1. process.env.CHATAPP_RELEASE_SHA (deploy-injected override), or
 *   2. backend/dist/.build-sha (written by write-dist-build-metadata.cjs), or
 *   3. 'unknown' (dev / test where neither is available).
 *
 * The Prometheus scrape from the monitoring VM relies on this series being
 * present on every chatapp-api worker so we can prove fleet-wide SHA parity
 * without SSH'ing each VM.
 */

const fs = require('fs');
const path = require('path');

describe('chatapp_build_info gauge', () => {
  // Force fresh module load per test so different env values are picked up.
  beforeEach(() => {
    jest.resetModules();
    delete process.env.CHATAPP_RELEASE_SHA;
  });

  it('registers a single gauge named chatapp_build_info with sha+version labels', () => {
    const metrics = require('../src/utils/metrics');
    const reg = metrics.register;
    const m = reg.getSingleMetric('chatapp_build_info');
    expect(m).toBeDefined();
    expect(m.name).toBe('chatapp_build_info');
    expect(m.type).toBe('gauge');
    // labelNames is exposed on the underlying prom-client metric definition.
    expect(Array.isArray(m.labelNames)).toBe(true);
    const labels = (m.labelNames as string[]).slice().sort();
    expect(labels).toEqual(['sha', 'version']);
  });

  it('emits exactly one series with value 1 (low cardinality)', async () => {
    const metrics = require('../src/utils/metrics');
    const m = metrics.register.getSingleMetric('chatapp_build_info');
    const snapshot = await m.get();
    expect(snapshot.values).toHaveLength(1);
    expect(snapshot.values[0].value).toBe(1);
    expect(typeof snapshot.values[0].labels.sha).toBe('string');
    expect(typeof snapshot.values[0].labels.version).toBe('string');
  });

  it('prefers CHATAPP_RELEASE_SHA over .build-sha when set to a valid 40-char hex', async () => {
    const fakeSha = 'a'.repeat(40);
    process.env.CHATAPP_RELEASE_SHA = fakeSha;
    const metrics = require('../src/utils/metrics');
    const m = metrics.register.getSingleMetric('chatapp_build_info');
    const snapshot = await m.get();
    expect(snapshot.values[0].labels.sha).toBe(fakeSha);
  });

  it('rejects malformed CHATAPP_RELEASE_SHA and falls back', async () => {
    process.env.CHATAPP_RELEASE_SHA = 'not-a-real-sha';
    const metrics = require('../src/utils/metrics');
    const m = metrics.register.getSingleMetric('chatapp_build_info');
    const snapshot = await m.get();
    // Either the on-disk .build-sha (40-hex) or the 'unknown' fallback —
    // crucially, NOT the bogus string from the env.
    expect(snapshot.values[0].labels.sha).not.toBe('not-a-real-sha');
    const isFortyHex = /^[0-9a-f]{40}$/i.test(String(snapshot.values[0].labels.sha));
    const isUnknown = snapshot.values[0].labels.sha === 'unknown';
    expect(isFortyHex || isUnknown).toBe(true);
  });

  it('reads sha from backend/dist/.build-sha when present and env unset', async () => {
    // dist/.build-sha is only present after `npm run build`. If a CI build
    // produced it, we expect the on-disk value to be reflected in the metric.
    // Otherwise (tsx-only test runs), the metric should be 'unknown'.
    const buildShaPath = path.join(__dirname, '..', 'dist', '.build-sha');
    const metrics = require('../src/utils/metrics');
    const snapshot = await metrics.register.getSingleMetric('chatapp_build_info').get();
    if (fs.existsSync(buildShaPath)) {
      const expected = String(fs.readFileSync(buildShaPath, 'utf8')).trim();
      if (/^[0-9a-f]{40}$/i.test(expected)) {
        expect(snapshot.values[0].labels.sha).toBe(expected);
      }
    } else {
      expect(snapshot.values[0].labels.sha).toBe('unknown');
    }
  });

  it("populates version from backend/package.json#version (or 'unknown')", async () => {
    const pkg = require('../package.json');
    const metrics = require('../src/utils/metrics');
    const snapshot = await metrics.register.getSingleMetric('chatapp_build_info').get();
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      expect(snapshot.values[0].labels.version).toBe(pkg.version);
    } else {
      expect(snapshot.values[0].labels.version).toBe('unknown');
    }
  });

  it('does not throw at module load even if both sources are missing', () => {
    // Sanity: even with everything stripped, requiring metrics.ts must succeed.
    process.env.CHATAPP_RELEASE_SHA = '';
    expect(() => require('../src/utils/metrics')).not.toThrow();
  });
});
