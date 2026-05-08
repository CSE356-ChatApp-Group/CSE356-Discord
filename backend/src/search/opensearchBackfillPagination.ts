type Cursor = {
  createdAtUs: string;
  id: string;
};

type PageRow = {
  createdAtUs: string;
  id: string;
};

type Order = 'asc' | 'desc';

function compareTuple(a: PageRow, b: PageRow): number {
  const aus = BigInt(a.createdAtUs);
  const bus = BigInt(b.createdAtUs);
  if (aus < bus) return -1;
  if (aus > bus) return 1;
  return a.id.localeCompare(b.id);
}

function sortRows(rows: PageRow[], order: Order): PageRow[] {
  const sorted = [...rows].sort(compareTuple);
  return order === 'asc' ? sorted : sorted.reverse();
}

function rowPassesBounds(row: PageRow, sinceUs?: string, untilUs?: string): boolean {
  const v = BigInt(row.createdAtUs);
  if (sinceUs && v < BigInt(sinceUs)) return false;
  if (untilUs && v > BigInt(untilUs)) return false;
  return true;
}

function rowPassesCursor(row: PageRow, cursor: Cursor, order: Order): boolean {
  const rowTuple = { createdAtUs: row.createdAtUs, id: row.id };
  const curTuple = { createdAtUs: cursor.createdAtUs, id: cursor.id };
  const cmp = compareTuple(rowTuple, curTuple);
  return order === 'asc' ? cmp > 0 : cmp < 0;
}

function pageFromCursor(
  rows: PageRow[],
  cursor: Cursor,
  limit: number,
  order: Order,
  sinceUs?: string,
  untilUs?: string,
): PageRow[] {
  const filtered = sortRows(rows, order).filter((row) => (
    rowPassesBounds(row, sinceUs, untilUs) && rowPassesCursor(row, cursor, order)
  ));
  return filtered.slice(0, limit);
}

function nextCursorFromPage(page: PageRow[]): Cursor | null {
  if (!page.length) return null;
  const last = page[page.length - 1];
  return { createdAtUs: String(last.createdAtUs), id: String(last.id) };
}

module.exports = {
  pageFromCursor,
  nextCursorFromPage,
  sortRows,
};

