/**
 * Optional Redis Streams append for message writes — durable log hook before Kafka/NATS.
 * Producer: append after Postgres commit on channel POST /messages.
 * Consumer: XREADGROUP ack loop (trim stream); extend to replay fanout or dual-write.
 *
 * **Scaffolding only:** safe for metrics / ACK plumbing. Before any **irreversible** side
 * effect (second writes, billing, external APIs), add **idempotency** at the consumer
 * boundary (message id + durable dedupe), not only Redis consumer-group delivery guarantees.
 */


const redis = require('../db/redis');
const logger = require('../utils/logger');
const { messageIngestStreamAppendedTotal, messageIngestStreamConsumedTotal } = require('../utils/metrics');

const STREAM_KEY = process.env.MESSAGE_INGEST_STREAM_KEY || 'chatapp:message_ingest';
const GROUP_NAME = process.env.MESSAGE_INGEST_STREAM_GROUP || 'ingest';
const CONSUMER_NAME = `ingest-${process.pid}-${process.env.PORT || '0'}`;
const MAXLEN = parseInt(process.env.MESSAGE_INGEST_STREAM_MAXLEN || '100000', 10);

function ingestEnabled() {
  const v = process.env.MESSAGE_INGEST_STREAM_ENABLED;
  return v === '1' || v === 'true';
}

function consumerEnabled() {
  const v = process.env.MESSAGE_INGEST_STREAM_CONSUMER;
  return v === '1' || v === 'true';
}

/**
 * Fire-and-forget append after a channel message is persisted (idempotent key = message id).
 */
function appendChannelMessageIngested(payload) {
  if (!ingestEnabled()) return;
  const maxLen = Number.isFinite(MAXLEN) && MAXLEN > 0 ? MAXLEN : 100000;
  redis
    .xadd(STREAM_KEY, 'MAXLEN', '~', String(maxLen), '*', 'payload', JSON.stringify(payload))
    .then(() => {
      messageIngestStreamAppendedTotal.inc({ result: 'ok' });
    })
    .catch((err) => {
      messageIngestStreamAppendedTotal.inc({ result: 'error' });
      logger.warn({ err, messageId: payload.messageId }, 'message ingest stream XADD failed');
    });
}

let consumerTimer = null;
let consumerStopping = false;

async function ensureConsumerGroup() {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
  } catch (err) {
    if (!String(err && err.message).includes('BUSYGROUP')) throw err;
  }
}

/**
 * Minimal consumer: ACK entries to prove pipeline; swap body for Kafka-style processors later.
 */
function startMessageIngestConsumerIfEnabled() {
  if (!ingestEnabled() || !consumerEnabled()) return;

  void (async () => {
    try {
      await ensureConsumerGroup();
      logger.info({ stream: STREAM_KEY, group: GROUP_NAME }, 'message ingest stream consumer starting');
    } catch (err) {
      logger.error({ err }, 'message ingest stream group create failed');
      return;
    }

    const tick = async () => {
      if (consumerStopping) return;
      try {
        const res = await redis.xreadgroup(
          'GROUP',
          GROUP_NAME,
          CONSUMER_NAME,
          'COUNT',
          '32',
          'BLOCK',
          '2000',
          'STREAMS',
          STREAM_KEY,
          '>',
        );
        if (!Array.isArray(res) || !res.length) return;
        for (const streamEntry of res) {
          const streamName = streamEntry[0];
          const messages = streamEntry[1];
          if (!Array.isArray(messages)) continue;
          for (const msg of messages) {
            const id = msg[0];
            await redis.xack(streamName, GROUP_NAME, id);
            messageIngestStreamConsumedTotal.inc({ result: 'ack' });
          }
        }
      } catch (err) {
        if (!consumerStopping) {
          logger.warn({ err }, 'message ingest consumer tick failed');
        }
      }
    };

    consumerTimer = setInterval(() => {
      void tick();
    }, 100);
    if (typeof consumerTimer.unref === 'function') consumerTimer.unref();
  })();
}

function stopMessageIngestConsumer() {
  consumerStopping = true;
  if (consumerTimer) {
    clearInterval(consumerTimer);
    consumerTimer = null;
  }
}

module.exports = {
  appendChannelMessageIngested,
  startMessageIngestConsumerIfEnabled,
  stopMessageIngestConsumer,
  ingestEnabled,
};
