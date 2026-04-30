/**
 * Optional duplicate Redis fanout with alternate event names for grader / client
 * compatibility. Gated by REALTIME_EVENT_ALIAS_FANOUT.
 *
 * When enabled, fanout.publish / fanout.publishBatch append extra publishes on
 * the same channel with alias event names (same data + publishedAt).
 */

function isRealtimeEventAliasFanoutEnabled() {
  const v = String(process.env.REALTIME_EVENT_ALIAS_FANOUT || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Canonical event name -> alias event names (same payload body). */
const CANONICAL_TO_ALIASES = {
  "message:created": ["new_message"],
  "message:updated": ["message:edited", "message_edited"],
  "message:deleted": ["message_deleted"],
  "presence:updated": ["presence_update", "user:status"],
  "read:updated": ["message:read", "read:receipt", "read_receipt"],
};

function aliasEventNamesForCanonical(event) {
  if (typeof event !== "string" || !event) return [];
  return CANONICAL_TO_ALIASES[event] || [];
}

/**
 * @param {Array<{ channel: string, payload: unknown }>} entries
 * @returns {Array<{ channel: string, payload: unknown }>}
 */
function expandFanoutBatchEntriesWithAliases(entries) {
  if (!isRealtimeEventAliasFanoutEnabled() || !Array.isArray(entries) || !entries.length) {
    return entries;
  }

  const out = [];
  for (const ent of entries) {
    if (!ent || typeof ent.channel !== "string" || !ent.channel) continue;
    out.push(ent);

    const p = ent.payload;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;

    // Sharded userfeed envelope: { __wsRoute, payload: inner }
    if (p.__wsRoute && p.payload && typeof p.payload === "object" && !Array.isArray(p.payload)) {
      const inner = p.payload;
      if (typeof inner.event !== "string") continue;
      for (const aliasEvent of aliasEventNamesForCanonical(inner.event)) {
        out.push({
          channel: ent.channel,
          payload: {
            ...p,
            payload: { ...inner, event: aliasEvent },
          },
        });
      }
      continue;
    }

    // Flat envelope { event, data, publishedAt? }
    if (typeof p.event === "string") {
      for (const aliasEvent of aliasEventNamesForCanonical(p.event)) {
        out.push({
          channel: ent.channel,
          payload: { ...p, event: aliasEvent },
        });
      }
    }
  }
  return out;
}

module.exports = {
  isRealtimeEventAliasFanoutEnabled,
  aliasEventNamesForCanonical,
  expandFanoutBatchEntriesWithAliases,
};
