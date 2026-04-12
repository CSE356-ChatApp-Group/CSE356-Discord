import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import MemberList from './MemberList';
import { useAuthStore } from '../stores/authStore';
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
}));

describe('MemberList DM presence', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    act(() => {
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
    apiGetMock.mockResolvedValue({
      presence: {
        'user-1': 'online',
        'user-2': 'away',
      },
      awayMessages: {
        'user-2': 'Lunch',
      },
    });

    render(<MemberList />);

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalled();
      expect(screen.getByTestId('member-row-user-1')).toHaveAttribute('data-member-status', 'online');
      expect(screen.getByTestId('member-row-user-2')).toHaveAttribute('data-member-status', 'away');
    });

    expect(screen.getByText('Lunch')).toBeInTheDocument();
  });
});

describe('MemberList community role management', () => {
  const updateCommunityMemberRole = vi.fn();

  beforeEach(() => {
    updateCommunityMemberRole.mockReset();
    updateCommunityMemberRole.mockResolvedValue(undefined);

    act(() => {
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
          { id: 'user-1', username: 'owner', role: 'owner' },
          { id: 'user-2', username: 'alex', role: 'member' },
        ],
        presence: {
          'user-1': 'online',
          'user-2': 'online',
        },
        awayMessages: {},
        updateCommunityMemberRole,
      } as any);
    });
  });

  afterEach(() => {
    act(() => {
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
});
