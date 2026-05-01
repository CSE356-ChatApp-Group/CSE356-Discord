/**
 * Pure validation helpers for POST /messages body/target.
 */

const {
  ALLOWED_ATTACHMENT_TYPES,
} = require("./postConstants");

function isValidMessageAttachment(attachment: any): boolean {
  return Boolean(
    attachment &&
      typeof attachment.storageKey === "string" &&
      attachment.storageKey.trim() &&
      typeof attachment.filename === "string" &&
      attachment.filename.trim() &&
      ALLOWED_ATTACHMENT_TYPES.has(attachment.contentType) &&
      Number.isInteger(Number(attachment.sizeBytes)) &&
      Number(attachment.sizeBytes) > 0,
  );
}

function validateAttachmentsPayload(attachments: any[]): string | null {
  const hasInvalidAttachment = attachments.some(
    (attachment) => !isValidMessageAttachment(attachment),
  );
  if (hasInvalidAttachment) {
    return "attachments must include storageKey, filename, contentType, and sizeBytes";
  }
  return null;
}

function validatePostTargetAndPayload({
  channelId,
  conversationId,
  normalizedContent,
  attachments,
}: {
  channelId: string | null;
  conversationId: string | null;
  normalizedContent: string;
  attachments: any[];
}): string | null {
  if (!channelId && !conversationId) {
    return "channelId or conversationId required";
  }
  if (channelId && conversationId) {
    return "Specify only one of channelId or conversationId";
  }
  if (!normalizedContent && attachments.length === 0) {
    return "content or at least one attachment is required";
  }
  return null;
}

module.exports = {
  isValidMessageAttachment,
  validateAttachmentsPayload,
  validatePostTargetAndPayload,
};
