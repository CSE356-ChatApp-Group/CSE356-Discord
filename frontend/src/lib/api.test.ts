import { afterEach, describe, expect, it, vi } from 'vitest';

describe('api search GET de-dupe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shares identical in-flight search requests without caching settled search results', async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('./api');
    const path = '/search?q=hello&conversationId=conv-1';

    const first = api.get(path);
    const duplicate = api.get(path);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolvers[0]?.(new Response(JSON.stringify({ hits: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(Promise.all([first, duplicate])).resolves.toEqual([{ hits: [] }, { hits: [] }]);

    const afterSettle = api.get(path);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1]?.(new Response(JSON.stringify({ hits: [{ id: 'fresh' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(afterSettle).resolves.toEqual({ hits: [{ id: 'fresh' }] });
  });
});
