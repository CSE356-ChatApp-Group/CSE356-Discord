import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import CommunitySidebar from './CommunitySidebar';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';

describe('CommunitySidebar presence badge', () => {
  beforeEach(() => {
    window.localStorage.clear();
    act(() => {
      useChatStore.setState({
        communities: [],
        activeCommunity: null,
        conversations: [],
        activeConv: null,
      } as any);
    });
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ user: null } as any);
    });
  });

  it('shows the current user status on the bottom-left avatar badge', () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: 'user-1',
          username: 'sam',
          displayName: 'Sam',
          email: 'sam@example.com',
          status: 'idle',
        },
      } as any);
    });

    render(<CommunitySidebar />);

    expect(screen.getByTestId('account-presence-badge')).toHaveAttribute('aria-label', 'Current presence: idle');
  });

  it('falls back to persisted away intent when user profile has no status', () => {
    window.localStorage.setItem('chatapp:presence-intent', JSON.stringify({ status: 'away', awayMessage: 'lunch' }));
    act(() => {
      useAuthStore.setState({
        user: {
          id: 'user-1',
          username: 'sam',
          displayName: 'Sam',
          email: 'sam@example.com',
        },
      } as any);
    });

    render(<CommunitySidebar />);

    expect(screen.getByTestId('account-presence-badge')).toHaveAttribute('aria-label', 'Current presence: away');
  });

  it('shows clear feedback when community name/slug is too short', async () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: 'user-1',
          username: 'sam',
          displayName: 'Sam',
          email: 'sam@example.com',
        },
      } as any);
    });

    render(<CommunitySidebar />);

    fireEvent.click(screen.getByTestId('community-create-open'));
    fireEvent.change(screen.getByTestId('community-create-name'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('community-create-submit'));

    expect(await screen.findByText('Community name/slug must be at least 2 characters.')).toBeInTheDocument();
  });

  it('shows DM unread indicator when there is an unread DM and user is not on DM tab', () => {
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
        activeCommunity: { id: 'community-1', name: 'General' },
        conversations: [{
          id: 'conv-1',
          participants: [{ id: 'user-1' }, { id: 'user-2' }],
          last_message_id: 'msg-2',
          last_message_author_id: 'user-2',
          my_last_read_message_id: 'msg-1',
        }],
        activeConv: null,
        communities: [],
      } as any);
    });

    render(<CommunitySidebar />);

    expect(screen.getByTestId('home-dms-unread-indicator')).toBeInTheDocument();
  });

  it('hides DM unread indicator when user is already on DM tab', () => {
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
        activeCommunity: null,
        conversations: [{
          id: 'conv-1',
          participants: [{ id: 'user-1' }, { id: 'user-2' }],
          last_message_id: 'msg-2',
          last_message_author_id: 'user-2',
          my_last_read_message_id: 'msg-1',
        }],
        activeConv: { id: 'conv-1' },
        communities: [],
      } as any);
    });

    render(<CommunitySidebar />);

    expect(screen.queryByTestId('home-dms-unread-indicator')).not.toBeInTheDocument();
  });
});
