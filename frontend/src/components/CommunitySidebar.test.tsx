import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CommunitySidebar from './CommunitySidebar';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';

describe('CommunitySidebar presence badge', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useChatStore.setState({
      communities: [],
      activeCommunity: null,
      conversations: [],
      activeConv: null,
    } as any);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null } as any);
  });

  it('shows the current user status on the bottom-left avatar badge', () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
        status: 'idle',
      },
    } as any);

    render(<CommunitySidebar />);

    expect(screen.getByTestId('account-presence-badge')).toHaveAttribute('aria-label', 'Current presence: idle');
  });

  it('falls back to persisted away intent when user profile has no status', () => {
    window.localStorage.setItem('chatapp:presence-intent', JSON.stringify({ status: 'away', awayMessage: 'lunch' }));
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    } as any);

    render(<CommunitySidebar />);

    expect(screen.getByTestId('account-presence-badge')).toHaveAttribute('aria-label', 'Current presence: away');
  });

  it('shows clear feedback when community name/slug is too short', async () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    } as any);

    render(<CommunitySidebar />);

    fireEvent.click(screen.getByTestId('community-create-open'));
    fireEvent.change(screen.getByTestId('community-create-name'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('community-create-submit'));

    expect(await screen.findByText('Community name/slug must be at least 2 characters.')).toBeInTheDocument();
  });
});
