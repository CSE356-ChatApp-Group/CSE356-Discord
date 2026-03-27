import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import LoginPage from './LoginPage';
import { useAuthStore } from '../stores/authStore';

const originalLogin = useAuthStore.getState().login;

afterEach(() => {
  useAuthStore.setState({ login: originalLogin } as any);
});

describe('LoginPage', () => {
  it('exposes stable machine-navigation selectors and oauth links', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    expect(screen.getByTestId('page-login')).toBeInTheDocument();
    expect(screen.getByTestId('login-card')).toBeInTheDocument();
    expect(screen.getByTestId('login-form')).toBeInTheDocument();
    expect(screen.getByTestId('login-email')).toHaveAttribute('name', 'email');
    expect(screen.getByTestId('login-password')).toHaveAttribute('name', 'password');
    expect(screen.getByTestId('login-submit')).toBeInTheDocument();

    expect(screen.getByTestId('oauth-google')).toHaveAttribute('href', '/api/v1/auth/google');
    expect(screen.getByTestId('oauth-github')).toHaveAttribute('href', '/api/v1/auth/github');
    expect(screen.getByTestId('oauth-course')).toHaveAttribute('href', '/api/v1/auth/course');
  });

  it('submits credentials through auth store login action', async () => {
    const loginSpy = vi.fn().mockResolvedValue({ id: 'user-1' });
    useAuthStore.setState({ login: loginSpy } as any);

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByTestId('login-email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'Password1!' } });
    fireEvent.submit(screen.getByTestId('login-form'));

    await waitFor(() => {
      expect(loginSpy).toHaveBeenCalledWith('sam@example.com', 'Password1!');
    });
  });
});
