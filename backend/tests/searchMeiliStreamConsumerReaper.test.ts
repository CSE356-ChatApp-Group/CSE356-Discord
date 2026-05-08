/**
 * Meili Redis Stream consumer identity + stale-consumer reaper.
 *
 * Covers:
 *   - HOSTNAME env vs os.hostname() fallback for consumer names
 *   - XINFO CONSUMERS row parsing
 *   - XGROUP DELCONSUMER only for idle, zero-pending, non-active consumers
 */

describe('meiliClient stream consumer reaper / hostname', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
    jest.unmock('os');
  });

  function loadMeiliWithOsMock(hostnameFn: () => string, env: Record<string, string>) {
    jest.resetModules();
    jest.doMock('os', () => ({ hostname: hostnameFn }));
    process.env = {
      ...OLD_ENV,
      MEILI_ENABLED: 'true',
      MEILI_HOST: 'http://meili.test',
      MEILI_MASTER_KEY: 'test-key',
      MEILI_INDEX_MESSAGES: 'messages',
      MEILI_WRITE_STREAM_KEY: 'meili:messages:write:test',
      MEILI_WRITE_STREAM_GROUP: 'meili-indexers-test',
      MEILI_WRITE_STREAM_CONSUMER_ENABLED: 'false',
      ...env,
    };
    require('prom-client').register.clear();
    jest.doMock('../src/db/redis', () => ({
      redisSearch: {
        xadd: jest.fn().mockResolvedValue('0-0'),
        duplicate: jest.fn(),
      },
    }));
    return require('../src/search/meiliClient');
  }

  it('streamConsumerName prefers HOSTNAME over os.hostname()', () => {
    const meili = loadMeiliWithOsMock(() => 'os-host', {
      HOSTNAME: 'env-host',
      PORT: '4001',
    });
    expect(meili.__test.streamConsumerName(0)).toMatch(/^meili-env-host-4001-\d+-0$/);
  });

  it('streamConsumerName falls back to os.hostname when HOSTNAME unset', () => {
    const meili = loadMeiliWithOsMock(() => 'system-host', {
      PORT: '4002',
    });
    delete process.env.HOSTNAME;
    expect(meili.__test.streamConsumerName(1)).toMatch(/^meili-system-host-4002-\d+-1$/);
  });

  it('parseXinfoConsumerRow reads flat name/pending/idle fields', () => {
    const meili = loadMeiliWithOsMock(() => 'h', {});
    const row = ['name', 'c1', 'pending', 0, 'idle', 12345];
    expect(meili.__test.parseXinfoConsumerRow(row)).toEqual({
      name: 'c1',
      pending: 0,
      idle: 12345,
    });
    expect(meili.__test.parseXinfoConsumerRow(['incomplete'])).toBeNull();
  });

  it('reapStaleMeiliWriteStreamConsumers deletes idle zero-pending non-active consumers', async () => {
    const meili = loadMeiliWithOsMock(() => 'h', {
      MEILI_WRITE_STREAM_REAP_IDLE_MS: '1000',
    });
    const xgroup = jest.fn().mockResolvedValue(1);
    const client = {
      xinfo: jest.fn().mockResolvedValue([
        ['name', 'meili-active-0', 'pending', 0, 'idle', 9_999_999],
        ['name', 'meili-stale-0', 'pending', 0, 'idle', 9_999_999],
      ]),
      xgroup,
    };
    await meili.__test.reapStaleMeiliWriteStreamConsumers(client, 'meili-active-0');
    expect(xgroup).toHaveBeenCalledTimes(1);
    expect(xgroup).toHaveBeenCalledWith(
      'DELCONSUMER',
      'meili:messages:write:test',
      'meili-indexers-test',
      'meili-stale-0',
    );
    const metrics = await require('prom-client').register.metrics();
    expect(metrics).toMatch(/meili_write_stream_consumers_reaped_total\{[^}]*result="deleted"[^}]*\} 1/);
    expect(metrics).toMatch(/meili_write_stream_consumers_reaped_total\{[^}]*result="skipped_active"[^}]*\} 1/);
  });

  it('reapStaleMeiliWriteStreamConsumers skips consumers with pending > 0', async () => {
    const meili = loadMeiliWithOsMock(() => 'h', {
      MEILI_WRITE_STREAM_REAP_IDLE_MS: '1000',
    });
    const xgroup = jest.fn();
    await meili.__test.reapStaleMeiliWriteStreamConsumers(
      {
        xinfo: jest.fn().mockResolvedValue([
          ['name', 'meili-old-0', 'pending', 3, 'idle', 9_999_999],
        ]),
        xgroup,
      },
      'meili-current-0',
    );
    expect(xgroup).not.toHaveBeenCalled();
    const metrics = await require('prom-client').register.metrics();
    expect(metrics).toMatch(/meili_write_stream_consumers_reaped_total\{[^}]*result="skipped_pending"[^}]*\} 1/);
  });

  it('reapStaleMeiliWriteStreamConsumers skips consumers idle below threshold', async () => {
    const meili = loadMeiliWithOsMock(() => 'h', {
      MEILI_WRITE_STREAM_REAP_IDLE_MS: '500000',
    });
    const xgroup = jest.fn();
    await meili.__test.reapStaleMeiliWriteStreamConsumers(
      {
        xinfo: jest.fn().mockResolvedValue([
          ['name', 'meili-recent-0', 'pending', 0, 'idle', 1000],
        ]),
        xgroup,
      },
      'meili-current-0',
    );
    expect(xgroup).not.toHaveBeenCalled();
    const metrics = await require('prom-client').register.metrics();
    expect(metrics).toMatch(/meili_write_stream_consumers_reaped_total\{[^}]*result="skipped_recent"[^}]*\} 1/);
  });
});
