import { createRequire } from 'module';

const requireCjs = createRequire(__filename);
const pool = requireCjs('../../backend/src/db/pool').pool;
const meili = requireCjs('../../backend/src/search/meiliClient');
const { indexMessageToOpenSearch } = requireCjs('../../backend/src/search/opensearchClient');

async function main() {
  const id = String(process.env.SEED_ID || '').trim();
  if (!id) throw new Error('SEED_ID is required');
  const { rows } = await pool.query(
    `SELECT
      m.id,
      m.content,
      m.author_id,
      m.channel_id,
      m.conversation_id,
      ch.community_id,
      m.created_at,
      m.updated_at,
      m.deleted_at
    FROM messages m
    LEFT JOIN channels ch ON ch.id = m.channel_id
    WHERE m.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`message ${id} not found`);
  const doc = {
    id: row.id,
    content: row.content,
    authorId: row.author_id,
    channelId: row.channel_id,
    communityId: row.community_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
  await meili.indexMessage(doc);
  await indexMessageToOpenSearch(doc);
  console.log(JSON.stringify({ indexed: true, id }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

