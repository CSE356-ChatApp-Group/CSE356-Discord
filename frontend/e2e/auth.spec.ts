import { test, expect } from '@playwright/test';
import { buildUser, loginViaUiWithRetry, registerOrLogin } from './helpers/session';

test.describe('authentication', () => {
  // Register a shared user via the API once before any tests run.
  // Decoupling user creation from the register-UI test means:
  //   - login/wrong-password tests can each be retried independently
  //     without re-running the whole describe block
  //   - tests no longer share state through a module variable
  //   - no stale refresh-cookie leaking from test 1 into test 2's fresh context
  let sharedUser: ReturnType<typeof buildUser>;

  test.beforeAll(async ({ request }) => {
    sharedUser = buildUser('auth');
    await registerOrLogin(request, sharedUser);
  });

  test('registers a new user via the UI and lands on chat @full @heavy-auth @staging', async ({ page }) => {
    // Each run (including retries) creates its own uniquely-named user.
    const user = buildUser('newbie');

    await page.goto('/register');
    await expect(page.getByTestId('route-register')).toBeVisible();

    await page.locator('#register-email').fill(user.email);
    await page.locator('#register-username').fill(user.username);
    await page.locator('#register-display-name').fill(user.displayName);
    await page.locator('#register-password').fill(user.password);
    await page.getByTestId('register-submit').click();

    await expect(page.getByTestId('route-chat')).toBeVisible({ timeout: 15_000 });
  });

  test('logs in with valid credentials and can log out @full @heavy-auth @staging', async ({ page }) => {
    await loginViaUiWithRetry(page, sharedUser);
    await expect(page.getByTestId('route-chat')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('account-open').click();
    await page.getByTestId('account-logout').click();

    await page.waitForURL((url) => url.pathname.endsWith('/login'), { timeout: 15_000 }).catch(() => {});
    await expect(page.getByTestId('route-login')).toBeVisible({ timeout: 15_000 });
  });

  test('shows an inline error for a wrong password @full @heavy-auth @staging', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('route-login')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('login-email').fill(sharedUser.email);
    await page.getByTestId('login-password').fill('Definitely!Wrong!99');
    await page.getByTestId('login-submit').click();

    // Error banner appears and the user stays on the login page.
    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page.getByTestId('route-login')).toBeVisible();
  });
});
