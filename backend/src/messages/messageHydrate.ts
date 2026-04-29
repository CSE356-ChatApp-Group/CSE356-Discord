/**
 * Load a single message row with author + attachments for fanout / API responses.
 */

import {
  MESSAGE_SELECT_FIELDS,
  MESSAGE_AUTHOR_JSON,
} from "./sqlFragments";

const { query } = require("../db/pool");

async function loadHydratedMessageById(messageId: string) {
  const map = await loadHydratedMessagesByIds([messageId]);
  return map.get(messageId) || null;
}

/** One query for many ids — used by pending-replay drain to cut DB round-trips. */
async function loadHydratedMessagesByIds(messageIds: string[]) {
  const unique = [...new Set((messageIds || []).filter((id) => typeof id === "string" && id.length))];
  if (!unique.length) return new Map<string, Record<string, unknown>>();

  const { rows } = await query(
    `SELECT ${MESSAGE_SELECT_FIELDS},
            ${MESSAGE_AUTHOR_JSON},
            COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM messages m
     LEFT JOIN users u ON u.id = m.author_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.id = ANY($1::uuid[])
     GROUP BY m.id, u.id`,
    [unique],
  );

  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows as Array<{ id: string } & Record<string, unknown>>) {
    map.set(String(row.id), row as Record<string, unknown>);
  }
  return map;
}

module.exports = { loadHydratedMessageById, loadHydratedMessagesByIds };
