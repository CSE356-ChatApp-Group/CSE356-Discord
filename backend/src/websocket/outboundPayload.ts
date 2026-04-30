/**
 * Pure WebSocket outbound payload helpers (dedupe keys, reliable-event detection,
 * JSON shape for browser). Used by Redis→WS delivery and outbound queue flush.
 */


const WS_SOCKET_MESSAGE_DEDUPE_MAX = 512;

function shouldSkipSocketForLogicalChannel(ws, logicalChannel, parsed) {
  if (
    !(logicalChannel.startsWith("user:") || logicalChannel.startsWith("community:"))
    || !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    return false;
  }

  const ev = (parsed as { event?: unknown }).event;
  if (typeof ev !== "string" || !ev.startsWith("message:")) return false;

  const data = (parsed as {
    data?: {
      channel_id?: string;
      channelId?: string;
      conversation_id?: string;
      conversationId?: string;
    };
  }).data;
  const chId = data?.channel_id || data?.channelId;
  return !!(
    chId
    && (ws as { _explicitChannelUnsub?: Set<string> })._explicitChannelUnsub?.has(`channel:${chId}`)
  );
}

function socketMessageDedupeKey(parsed) {
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    return null;
  }

  const eventName = (parsed as { event?: unknown }).event;
  if (typeof eventName !== "string" || !eventName.startsWith("message:")) {
    return null;
  }

  const data = (parsed as {
    data?: {
      id?: unknown;
      messageId?: unknown;
      message_id?: unknown;
    };
  }).data;
  const messageId = data?.id || data?.messageId || data?.message_id;
  if (typeof messageId !== "string" || !messageId) {
    return null;
  }

  return `${eventName}:${messageId}`;
}

function wasSocketMessageRecentlyDelivered(ws, dedupeKey) {
  if (!dedupeKey) return false;
  const recent = (ws as { _recentMessageKeys?: Map<string, number> })._recentMessageKeys;
  return !!recent?.has(dedupeKey);
}

function markSocketMessageDelivered(ws, dedupeKey) {
  if (!dedupeKey) return;
  if (!(ws as { _recentMessageKeys?: Map<string, number> })._recentMessageKeys) {
    (ws as { _recentMessageKeys: Map<string, number> })._recentMessageKeys = new Map();
  }
  const recent = (ws as { _recentMessageKeys: Map<string, number> })._recentMessageKeys;
  recent.set(dedupeKey, Date.now());
  while (recent.size > WS_SOCKET_MESSAGE_DEDUPE_MAX) {
    const oldestKey = recent.keys().next().value;
    if (!oldestKey) break;
    recent.delete(oldestKey);
  }
}

function extractInternalUserFeedCommand(payload) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
  ) {
    return null;
  }

  const internal = (payload as { __wsInternal?: unknown }).__wsInternal;
  if (
    !internal
    || typeof internal !== "object"
    || Array.isArray(internal)
    || typeof (internal as { kind?: unknown }).kind !== "string"
  ) {
    return null;
  }

  return internal as { kind: string; channels?: unknown; communityIds?: unknown };
}

function isReliableRealtimeEvent(eventName) {
  if (typeof eventName !== "string" || !eventName) return false;
  if (eventName.startsWith("message:")) return true;

  return (
    eventName === "read:updated"
    || eventName === "conversation:invited"
    || eventName === "conversation:invite"
    || eventName === "conversation:created"
    || eventName === "conversation:participant_added"
  );
}

/** Buckets `ws_reliable_delivery_topic_total` — bounded label cardinality. */
function wsDeliveryTopicPrefixForMetrics(logicalChannel) {
  if (typeof logicalChannel !== "string") return "other";
  const idx = logicalChannel.indexOf(":");
  if (idx <= 0) return "other";
  const prefix = logicalChannel.slice(0, idx);
  if (
    prefix === "channel"
    || prefix === "user"
    || prefix === "conversation"
    || prefix === "community"
    || prefix === "userfeed"
  ) {
    return prefix;
  }
  return "other";
}

/** Epoch ms for latency (message row time or fanout publishedAt); null if unknown. */
function parsePayloadReferenceTimeMs(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data = (parsed as { data?: unknown }).data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const row = data as Record<string, unknown>;
    const ca = row.created_at ?? row.createdAt;
    if (typeof ca === "string") {
      const t = Date.parse(ca);
      if (Number.isFinite(t)) return t;
    }
    if (typeof ca === "number" && Number.isFinite(ca)) return Math.floor(ca);
  }
  const pub = (parsed as { publishedAt?: unknown }).publishedAt;
  if (typeof pub === "string") {
    const t = Date.parse(pub);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function prepareSocketPayload(logicalChannel, parsed, rawMessage) {
  const dedupeKey = socketMessageDedupeKey(parsed);
  let payloadEventName;
  let skipDropForBackpressure = false;
  let outbound = rawMessage;
  if (
    parsed
    && typeof parsed === "object"
    && parsed !== null
    && !Array.isArray(parsed)
  ) {
    const ev = (parsed as { event?: unknown }).event;
    if (typeof ev === "string") {
      payloadEventName = ev;
      if (isReliableRealtimeEvent(ev)) {
        skipDropForBackpressure = true;
      }
    }
    outbound = JSON.stringify({ ...parsed, channel: logicalChannel });
  }

  return { dedupeKey, outbound, payloadEventName, skipDropForBackpressure };
}

module.exports = {
  WS_SOCKET_MESSAGE_DEDUPE_MAX,
  shouldSkipSocketForLogicalChannel,
  socketMessageDedupeKey,
  wasSocketMessageRecentlyDelivered,
  markSocketMessageDelivered,
  extractInternalUserFeedCommand,
  isReliableRealtimeEvent,
  wsDeliveryTopicPrefixForMetrics,
  parsePayloadReferenceTimeMs,
  prepareSocketPayload,
};
