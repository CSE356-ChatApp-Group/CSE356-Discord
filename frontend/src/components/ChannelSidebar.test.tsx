import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChannelSidebar from './ChannelSidebar';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';

describe('ChannelSidebar destructive actions', () => {
  const deleteChannel = vi.fn();
  const deleteCommunity = vi.fn();
  const leaveCommunity = vi.fn();

  beforeEach(() => {
    deleteChannel.mockReset();
    deleteChannel.mockResolvedValue(undefined);
    deleteCommunity.mockReset();
    deleteCommunity.mockResolvedValue(undefined);
    leaveCommunity.mockReset();
    leaveCommunity.mockResolvedValue(undefined);

    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    } as any);

    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'Workspace', my_role: 'moderator' },
      channels: [
        { id: 'ch-1', name: 'general', is_private: false },
      ],
      activeChannel: null,
      conversations: [],
      pendingDmInvites: [],
      activeConv: null,
      selectChannel: vi.fn(),
      selectConversation: vi.fn(),
      createChannel: vi.fn(),
      deleteChannel,
      deleteCommunity,
      leaveCommunity,
      openDm: vi.fn(),
      acceptDmInvite: vi.fn(),
      declineDmInvite: vi.fn(),
    } as any);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null } as any);
    useChatStore.setState({
      activeCommunity: null,
      channels: [],
      activeChannel: null,
      conversations: [],
      pendingDmInvites: [],
      activeConv: null,
    } as any);
  });

  it('opens a delete confirmation modal and deletes the selected channel', async () => {
    render(<ChannelSidebar />);

    fireEvent.click(screen.getByTestId('channel-delete-ch-1'));

    expect(screen.getByTestId('channel-delete-modal')).toBeInTheDocument();
    expect(screen.getByText('Delete #general? This action cannot be undone.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('channel-delete-confirm'));

    await waitFor(() => {
      expect(deleteChannel).toHaveBeenCalledWith('ch-1');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('channel-delete-modal')).not.toBeInTheDocument();
    });
  });

  it('shows an owner-only delete community modal and confirms deletion', async () => {
    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'Workspace', my_role: 'owner' },
    } as any);

    render(<ChannelSidebar />);

    expect(screen.queryByTestId('community-leave-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('community-delete-btn'));

    expect(screen.getByTestId('community-delete-modal')).toBeInTheDocument();
    expect(screen.getByText('Delete Workspace? All channels and messages in this community will be permanently removed.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('community-delete-confirm'));

    await waitFor(() => {
      expect(deleteCommunity).toHaveBeenCalledWith('comm-1');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('community-delete-modal')).not.toBeInTheDocument();
    });
  });
});