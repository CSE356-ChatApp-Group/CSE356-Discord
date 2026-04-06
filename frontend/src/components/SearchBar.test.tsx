import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SearchBar from './SearchBar';
import { useChatStore } from '../stores/chatStore';

const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    postForm: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  invalidateApiCache: vi.fn(),
}));

describe('SearchBar filters', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ hits: [] });

    act(() => {
      useChatStore.setState({
        activeConv: {
          id: 'conv-1',
          participants: [
            { id: 'user-1', username: 'abcdef', displayName: 'ABCDEF' },
            { id: 'user-2', username: 'abcd', displayName: 'ABCD' },
          ],
        },
        members: [],
        searchResults: [],
        searchQuery: 'hello',
        searchFilters: { author: '', after: '', before: '' },
      } as any);
    });
  });

  afterEach(() => {
    act(() => {
      useChatStore.setState({
        activeConv: null,
        members: [],
        searchResults: null,
        searchQuery: '',
        searchFilters: { author: '', after: '', before: '' },
      } as any);
    });
  });

  it('shows author and time filters and reruns search when they change', async () => {
    render(<SearchBar onClose={() => {}} />);

    expect(screen.getByTestId('search-filters-panel')).toBeInTheDocument();
    expect(screen.getByTestId('search-filter-author')).toBeInTheDocument();
    expect(screen.getByTestId('search-filter-after')).toBeInTheDocument();
    expect(screen.getByTestId('search-filter-before')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('search-filter-author'), {
      target: { value: 'abcd' },
    });

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('authorId=user-2'));
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('conversationId=conv-1'));
    });

    const afterValue = '2026-04-06T09:15';
    fireEvent.change(screen.getByTestId('search-filter-after'), {
      target: { value: afterValue },
    });

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith(
        expect.stringContaining(`after=${encodeURIComponent(new Date(afterValue).toISOString())}`)
      );
    });
  });
});
