const logger = require('../utils/logger');
const {
  isOpenSearchEnabled,
  indexMessageToOpenSearch,
  tombstoneOrDeleteMessageInOpenSearch,
} = require('./opensearchClient');

function isDualWriteEnabled(): boolean {
  return String(process.env.OPENSEARCH_DUAL_WRITE_ENABLED || 'false').trim().toLowerCase() === 'true'
    && isOpenSearchEnabled();
}

async function dualWriteIndexMessage(message: any): Promise<void> {
  if (!isDualWriteEnabled()) return;
  try {
    await indexMessageToOpenSearch(message);
  } catch (err: any) {
    logger.warn(
      { err: { message: err?.message }, messageId: String(message?.id || '') },
      'opensearch: dual-write index failed',
    );
  }
}

async function dualWriteDeleteMessage(messageId: string, deletedAt?: string | Date | null): Promise<void> {
  if (!isDualWriteEnabled()) return;
  try {
    await tombstoneOrDeleteMessageInOpenSearch(messageId, deletedAt);
  } catch (err: any) {
    logger.warn(
      { err: { message: err?.message }, messageId },
      'opensearch: dual-write delete failed',
    );
  }
}

module.exports = {
  isDualWriteEnabled,
  dualWriteIndexMessage,
  dualWriteDeleteMessage,
};
