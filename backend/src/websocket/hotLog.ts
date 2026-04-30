type HotLoggerDeps = {
  logger: { info: (payload: unknown, message: string) => void };
  isRuntimeLogCategoryEnabled: (category: string, enabledByDefault?: boolean) => boolean;
  defaultRate: number;
};

function createWsHotLogger({ logger, isRuntimeLogCategoryEnabled, defaultRate }: HotLoggerDeps) {
  function shouldSampleWsHotLog(rate = defaultRate) {
    if (!isRuntimeLogCategoryEnabled('ws_hot_info', rate > 0)) return false;
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  function logWsHotInfo(
    payloadFactory: unknown | (() => unknown),
    message: string,
    rate = defaultRate,
  ) {
    if (!shouldSampleWsHotLog(rate)) return;
    const payload =
      typeof payloadFactory === 'function' ? (payloadFactory as () => unknown)() : payloadFactory;
    logger.info(payload, message);
  }

  return {
    shouldSampleWsHotLog,
    logWsHotInfo,
  };
}

module.exports = {
  createWsHotLogger,
};
