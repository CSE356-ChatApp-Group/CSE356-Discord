const SELECT_COLS = `
  m.id,
  m.content,
  m.author_id        AS "authorId",
  COALESCE(NULLIF(u.display_name, ''), u.username) AS "authorDisplayName",
  m.channel_id       AS "channelId",
  m.conversation_id  AS "conversationId",
  m.created_at       AS "createdAt",
  ch.community_id    AS "communityId",
  ch.name            AS "channelName"`;

const SELECT_COLS_FROM_SCOPED_CANDIDATE = `
  m.id,
  m.content,
  m.author_id        AS "authorId",
  COALESCE(NULLIF(u.display_name, ''), u.username) AS "authorDisplayName",
  m.channel_id       AS "channelId",
  m.conversation_id  AS "conversationId",
  m.created_at       AS "createdAt",
  sc.community_id    AS "communityId",
  sc.channel_name    AS "channelName"`;

const FROM_CLAUSE = `
  FROM messages m
  JOIN users u ON u.id = m.author_id
  LEFT JOIN channels ch ON ch.id = m.channel_id`;

const FTS_FROM_CLAUSE = `
  FROM messages m
  CROSS JOIN search_query sq
  JOIN users u ON u.id = m.author_id
  LEFT JOIN channels ch ON ch.id = m.channel_id`;

function p(params: any[], v: any): string {
  params.push(v);
  return `$${params.length}`;
}

function buildScopedAccessParts(params: any[], opts: Record<string, any>) {
  if (opts.conversationId) {
    const conversationId = p(params, opts.conversationId);
    const userId = p(params, opts.userId);
    return {
      scopeType: 'conversation',
      targetIdPh: conversationId,
      userIdPh: userId,
      cte: `
        scope_access AS (
          SELECT EXISTS (
            SELECT 1
            FROM conversation_participants cp
            WHERE cp.conversation_id = ${conversationId}
              AND cp.user_id = ${userId}
              AND cp.left_at IS NULL
          ) AS has_access
        )`,
      fromClause: 'FROM scope_access',
      onClause: 'ON scope_access.has_access = TRUE',
    };
  }

  if (opts.communityId) {
    const communityId = p(params, opts.communityId);
    const userId = p(params, opts.userId);
    return {
      scopeType: 'community',
      targetIdPh: communityId,
      userIdPh: userId,
      cte: `
        scope_access AS (
          SELECT EXISTS (
            SELECT 1
            FROM community_members
            WHERE community_id = ${communityId}
              AND user_id = ${userId}
          ) AS has_access
        )`,
      fromClause: 'FROM scope_access',
      onClause: 'ON scope_access.has_access = TRUE',
    };
  }

  return null;
}

function buildAuthorTimeFilters(
  params: any[],
  opts: Record<string, any>,
  alias = 'm',
): string {
  const parts: string[] = [];
  if (opts.authorId) parts.push(`AND ${alias}.author_id = ${p(params, opts.authorId)}`);
  if (opts.after) parts.push(`AND ${alias}.created_at >= ${p(params, opts.after)}::timestamptz`);
  if (opts.before) parts.push(`AND ${alias}.created_at <= ${p(params, opts.before)}::timestamptz`);
  return parts.join('\n');
}

function buildFilters(params: any[], opts: Record<string, any>): string {
  const parts: string[] = [];

  if (opts.conversationId) {
    parts.push(`AND m.conversation_id = ${p(params, opts.conversationId)}`);
  } else if (opts.communityId) {
    const cid = p(params, opts.communityId);
    const uid = p(params, opts.userId);
    parts.push(`
    AND m.channel_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM channels ch2
      LEFT JOIN channel_members cm ON cm.channel_id = ch2.id AND cm.user_id = ${uid}
      WHERE ch2.id = m.channel_id
        AND ch2.community_id = ${cid}
        AND (ch2.is_private = FALSE OR cm.user_id IS NOT NULL)
    )`);
  }

  const authorTimeFilters = buildAuthorTimeFilters(params, opts);
  if (authorTimeFilters) parts.push(authorTimeFilters);

  return parts.join('\n');
}

function buildStrictLiteralPredicate(
  contentExpr: string,
  strictMultiWord: boolean,
  strictTermLikePhs: string[],
  rawQueryPh: string,
): string {
  if (strictMultiWord) {
    return strictTermLikePhs
      .map((ph) => `lower(coalesce(${contentExpr}, '')) LIKE ('%' || ${ph}::text || '%')`)
      .join('\n             AND ');
  }
  return `lower(coalesce(${contentExpr}, '')) LIKE ('%' || lower(${rawQueryPh}::text) || '%')
             OR position(lower(${rawQueryPh}::text) in lower(coalesce(${contentExpr}, ''))) > 0`;
}

module.exports = {
  SELECT_COLS,
  SELECT_COLS_FROM_SCOPED_CANDIDATE,
  FROM_CLAUSE,
  FTS_FROM_CLAUSE,
  p,
  buildScopedAccessParts,
  buildAuthorTimeFilters,
  buildFilters,
  buildStrictLiteralPredicate,
};
