/**
 * Unit tests for READ_RECEIPT_MESSAGE_ACK_CACHE_* parsing (no DB/Redis).
 */

const {
  parseMessageAckCacheEnabled,
  parseMessageAckCacheTtlMs,
} = require('../src/messages/readReceipt/readReceiptMessageAckCache');

describe('readReceiptMessageAckCache env parsing', () => {
  const prevE = process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED;
  const prevT = process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS;

  afterEach(() => {
    if (prevE === undefined) delete process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED;
    else process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED = prevE;
    if (prevT === undefined) delete process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS;
    else process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS = prevT;
  });

  it('defaults disabled and TTL 60000', () => {
    delete process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED;
    delete process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS;
    expect(parseMessageAckCacheEnabled()).toBe(false);
    expect(parseMessageAckCacheTtlMs()).toBe(60000);
  });

  it('clamps TTL to 5000 minimum', () => {
    process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS = '100';
    expect(parseMessageAckCacheTtlMs()).toBe(5000);
  });

  it('clamps TTL to 600000 maximum', () => {
    process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS = '99999999';
    expect(parseMessageAckCacheTtlMs()).toBe(600000);
  });

  it('parses enabled true variants', () => {
    for (const v of ['true', '1', 'yes', 'YES']) {
      process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED = v;
      expect(parseMessageAckCacheEnabled()).toBe(true);
    }
  });
});
