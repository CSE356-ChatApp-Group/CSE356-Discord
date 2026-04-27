/**
 * Load a single message row with author + attachments for fanout / API responses.
 */

import {
  MESSAGE_SELECT_FIELDS,
  MESSAGE_AUTHOR_JSON,
} from "./sqlFragments";

const { query } = require("../db/pool");

async function loadHydratedMessageById(messageId: string) {
  const { rows } = await query(
    `SELECT ${MESSAGE_SELECT_FIELDS},
            ${MESSAGE_AUTHOR_JSON},
            COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM messages m
     LEFT JOIN users u ON u.id = m.author_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.id = $1
     GROUP BY m.id, u.id`,
    [messageId],
  );
  return rows[0] || null;
}

module.exports = { loadHydratedMessageById };
