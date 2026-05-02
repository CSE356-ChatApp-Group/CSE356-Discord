import * as os from "node:os";

export const READ_RECEIPT_TARGET_LOOKUP_CALLER = "read_receipt_target_lookup";

/**
 * Low-cardinality fields for pool slow/fallback logs on read-receipt message-target
 * lookup (no tokens, message body, or email).
 */
export function readReceiptTargetLookupReadDiagnosticFields(input: {
  messageId: string;
  userId: string;
  requestId?: string;
  includeCommunityId: boolean;
  preferCache: boolean;
  accessScope: "unknown" | "channel" | "conversation";
}): Record<string, string | number | boolean> {
  const workerId = `${os.hostname()}:${process.env.PORT || "?"}`;
  const out: Record<string, string | number | boolean> = {
    caller: READ_RECEIPT_TARGET_LOOKUP_CALLER,
    route: READ_RECEIPT_TARGET_LOOKUP_CALLER,
    messageId: input.messageId,
    userId: input.userId,
    includeCommunityId: input.includeCommunityId,
    preferCache: input.preferCache,
    accessScope: input.accessScope,
    workerId,
    processPid: process.pid,
  };
  if (input.requestId) out.requestId = input.requestId;
  return out;
}
