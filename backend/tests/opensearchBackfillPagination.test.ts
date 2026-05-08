const {
  pageFromCursor,
  nextCursorFromPage,
} = require('../src/search/opensearchBackfillPagination');

describe('OpenSearch backfill pagination', () => {
  const rows = [
    { createdAtUs: '1000', id: '00000000-0000-4000-8000-000000000001' },
    { createdAtUs: '1000', id: '00000000-0000-4000-8000-000000000002' },
    { createdAtUs: '1000', id: '00000000-0000-4000-8000-000000000003' },
    { createdAtUs: '2000', id: '00000000-0000-4000-8000-000000000004' },
    { createdAtUs: '3000', id: '00000000-0000-4000-8000-000000000005' },
  ];

  it('does not duplicate rows across ascending pages with identical timestamps', () => {
    let cursor = { createdAtUs: '0', id: '00000000-0000-0000-0000-000000000000' };
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const page = pageFromCursor(rows, cursor, 2, 'asc');
      if (!page.length) break;
      for (const row of page) {
        const key = `${row.createdAtUs}:${row.id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      cursor = nextCursorFromPage(page)!;
    }
    expect(seen.size).toBe(rows.length);
  });

  it('supports descending latest-first pagination with strict cursor', () => {
    let cursor = { createdAtUs: '9223372036854775807', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const page = pageFromCursor(rows, cursor, 2, 'desc');
      if (!page.length) break;
      ids.push(...page.map((r: any) => r.id));
      cursor = nextCursorFromPage(page)!;
    }
    expect(ids).toEqual([
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('resumes correctly from checkpoint cursor', () => {
    const page = pageFromCursor(
      rows,
      { createdAtUs: '1000', id: '00000000-0000-4000-8000-000000000002' },
      10,
      'asc',
    );
    expect(page.map((r: any) => r.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
    ]);
  });

  it('applies since and until boundaries', () => {
    const page = pageFromCursor(
      rows,
      { createdAtUs: '0', id: '00000000-0000-0000-0000-000000000000' },
      20,
      'asc',
      '1000',
      '2000',
    );
    expect(page.map((r: any) => r.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ]);
  });

  it('terminates without infinite loop when no rows remain', () => {
    const page = pageFromCursor(
      rows,
      { createdAtUs: '3000', id: '00000000-0000-4000-8000-000000000005' },
      10,
      'asc',
    );
    expect(page).toEqual([]);
  });
});

