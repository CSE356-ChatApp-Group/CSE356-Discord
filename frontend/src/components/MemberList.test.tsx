import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import MemberList from './MemberList';
import { useAuthStore } from '../stores/authStore';
import { resetChatStore, useChatStore } from '../stores/chatStore';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    postForm: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('MemberList DM presence', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    act(() => {
      resetChatStore();
      useAuthStore.setState({
        user: {
          id: 'user-1',
          username: 'sam',
          displayName: 'Sam',
          email: 'sam@example.com',
        },
      } as any);

      useChatStore.setState({
        activeConv: {
          id: 'conv-1',
          participants: [
            { id: 'user-1', username: 'sam', displayName: 'Sam' },
            { id: 'user-2', username: 'alex', displayName: 'Alex' },
          ],
        },
        members: [],
        presence: {},
        awayMessages: {},
      } as any);
    });
  });

  afterEach(() => {
    act(() => {
      resetChatStore();
      useAuthStore.setState({ user: null } as any);
      useChatStore.setState({
        activeConv: null,
        members: [],
        presence: {},
        awayMessages: {},
      } as any);
    });
  });

  it('fetches and renders latest participant statuses for DMs', async () => {
    apiPostMock.mockImplementation((path: string, body: any) => {
      expect(path).toBe('/presence/bulk');
      expect(body?.userIds).toEqual(expect.arrayContaining(['user-1', 'user-2']));
      return Promise.resolve({
      presence: {
        'user-1': 'online',
        'user-2': 'away',
      },
      awayMessages: {
        'user-2': 'Lunch',
      },
    });
    });

    render(<MemberList />);

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalled();
      expect(screen.getByTestId('member-row-user-1')).toHaveAttribute('data-member-status', 'online');
      expect(screen.getByTestId('member-row-user-2')).toHaveAttribute('data-member-status', 'away');
    });

    expect(screen.getByText('Lunch')).toBeInTheDocument();
  });
});

describe('MemberList community role management', () => {
  const updateCommunityMemberRole = vi.fn();

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    updateCommunityMemberRole.mockReset();
    updateCommunityMemberRole.mockResolvedValue(undefined);

    act(() => {
      resetChatStore();
      useAuthStore.setState({
        user: {
          id: 'user-1',
          username: 'owner',
          displayName: 'Owner',
          email: 'owner@example.com',
        },
      } as any);

      useChatStore.setState({
        activeConv: null,
        activeCommunity: { id: 'community-1', my_role: 'owner' },
        members: [
          { id: 'user-1', username: 'owner', role: 'owner', status: 'online' },
          { id: 'user-2', username: 'alex', role: 'member', status: 'away', away_message: 'Reviewing PRs' },
        ],
        presence: {},
        awayMessages: {},
        updateCommunityMemberRole,
      } as any);
    });
  });

  afterEach(() => {
    act(() => {
      resetChatStore();
      useAuthStore.setState({ user: null } as any);
      useChatStore.setState({
        activeCommunity: null,
        activeConv: null,
        members: [],
        presence: {},
        awayMessages: {},
      } as any);
    });
  });

  it('lets the owner promote a member to admin', async () => {
    render(<MemberList />);

    await act(async () => {
      screen.getByTestId('member-role-toggle-user-2').click();
    });

    expect(updateCommunityMemberRole).toHaveBeenCalledWith('community-1', 'user-2', 'admin');
  });

  it('renders community presence from the members payload without rehydrating in bulk', async () => {
    render(<MemberList />);

    expect(apiPostMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('member-row-user-1')).toHaveAttribute('data-member-status', 'online');
    expect(screen.getByTestId('member-row-user-2')).toHaveAttribute('data-member-status', 'away');
    expect(screen.getByText('Reviewing PRs')).toBeInTheDocument();
  });
});
