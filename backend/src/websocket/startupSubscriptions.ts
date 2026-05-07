const { runWithConcurrencyLimit } = require("./userFeed");
const logger = require("../utils/logger");
const fs = require("fs");

function debugLog(msg) {
  try {
    fs.writeSync(1, `${new Date().toISOString()} [WS STARTUP] ${msg}\n`);
  } catch {
    console.log(msg);
  }
}

function createStartupSubscriptionsLifecycle({
  ensureRedisChannelSubscribed,
  userFeedShardChannels = [],
  workerUserFeedChannel = null,
  logWsHotInfo,
}) {
  let wsStartupPromise = null;

  async function ensureShardSubscriptions() {
    const channels = Array.isArray(userFeedShardChannels)
      ? userFeedShardChannels.filter((channel) => typeof channel === "string" && channel)
      : [];
    if (workerUserFeedChannel) {
      channels.unshift(workerUserFeedChannel);
    }
    const uniqueChannels = Array.from(new Set(channels));
    const total = uniqueChannels.length;
    let completed = 0;

    debugLog(`Starting ${total} shard subscriptions in background...`);
    logger.info({ total }, "Starting WS shard subscriptions");

    try {
      await runWithConcurrencyLimit(
        uniqueChannels.map((redisChannel) => async () => {
          try {
            // Per-channel timeout of 10s
            await Promise.race([
              ensureRedisChannelSubscribed(redisChannel),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`Timeout subscribing to ${redisChannel}`)), 10000)
              )
            ]);
            completed += 1;
            if (completed % 32 === 0 || completed === total) {
              debugLog(`Progress: ${completed}/${total}`);
            }
          } catch (err) {
            debugLog(`Warning: Failed to subscribe to ${redisChannel}: ${err.message}`);
          }
        }),
        16,
      );
    } catch (err) {
      debugLog(`Error during shard subscriptions: ${err.message}`);
    }
    
    debugLog(`Finished background shard subscriptions: ${completed}/${total} successful`);
    
    logWsHotInfo(
      () => ({
        workerUserFeedChannel,
        userFeedShardCount: uniqueChannels.filter((channel) => channel.startsWith("userfeed:")).length,
        successful: completed,
      }),
      "WS startup shard subscriptions initialized",
    );
  }

  function ready() {
    if (!wsStartupPromise) {
      debugLog("ready() called for the first time");
      // Start subscriptions but don't block the promise we return
      ensureShardSubscriptions().catch(err => {
        debugLog(`FATAL background error: ${err.message}`);
      });
      
      // We return a promise that resolves quickly, allowing the server to start.
      // Realtime functionality for shards will be "best effort" as they come online.
      wsStartupPromise = Promise.resolve();
    }
    return wsStartupPromise;
  }

  return {
    ready,
  };
}

module.exports = {
  createStartupSubscriptionsLifecycle,
};
