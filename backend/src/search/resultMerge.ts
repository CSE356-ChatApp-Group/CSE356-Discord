function mergeSearchRowsPreferLiteral(
  literalRows: any[],
  ftsRows: any[],
  limit: number,
  offset: number,
) {
  const merged: any[] = [];
  const seen = new Set<string>();
  for (const row of literalRows || []) {
    if (!row || !row.id) continue;
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(row);
  }
  for (const row of ftsRows || []) {
    if (!row || !row.id) continue;
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(row);
  }
  return merged.slice(offset, offset + limit);
}

module.exports = {
  mergeSearchRowsPreferLiteral,
};
