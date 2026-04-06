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

  it('stores author and time filters locally and only searches when submitted', async () => {
    render(<SearchBar onClose={() => {}} currentQuery="hello" />);

    expect(screen.queryByTestId('search-filters-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('search-filters-toggle'));

    expect(screen.getByTestId('search-filters-panel')).toBeInTheDocument();
    expect(screen.getByTestId('search-filter-author')).toBeInTheDocument();
    expect(screen.getByTestId('search-filter-after')).toBeInTheDocument();
    expect(screen.getByTestId('search-filter-before')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('search-filter-author'), {
      target: { value: 'abcd' },
    });

    await waitFor(() => {
      expect(useChatStore.getState().searchFilters.author).toBe('abcd');
    });

    expect(apiGetMock).not.toHaveBeenCalled();

    const afterValue = '2026-04-06T09:15';
    fireEvent.change(screen.getByTestId('search-filter-after'), {
      target: { value: afterValue },
    });

    await waitFor(() => {
      expect(useChatStore.getState().searchFilters.after).toBe(afterValue);
    });

    expect(apiGetMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('search-submit'));

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('authorId=user-2'));
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('conversationId=conv-1'));
      expect(apiGetMock).toHaveBeenCalledWith(
        expect.stringContaining(`after=${encodeURIComponent(new Date(afterValue).toISOString())}`)
      );
    });
  });
});
