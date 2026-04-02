import { test, expect } from '@playwright/test';
import { buildUser, loginViaUiWithRetry } from './helpers/session';

test.describe('authentication', () => {
  test.describe.configure({ mode: 'serial' });

  let registeredUser: ReturnType<typeof buildUser> | null = null;

  test('registers a new user via the UI and lands on chat @full @heavy-auth @staging', async ({ page }) => {
    const user = buildUser('newbie');
    registeredUser = user;

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
    expect(registeredUser, 'registered user should exist from previous test').toBeTruthy();
    const user = registeredUser!;

    await loginViaUiWithRetry(page, user);
    await expect(page.getByTestId('route-chat')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('account-open').click();
    await page.getByTestId('account-logout').click();

    await page.waitForURL((url) => url.pathname.endsWith('/login'), { timeout: 15_000 }).catch(() => {});
    await expect(page.getByTestId('route-login')).toBeVisible({ timeout: 15_000 });
  });

  test('shows an inline error for a wrong password @full @heavy-auth @staging', async ({ page }) => {
    expect(registeredUser, 'registered user should exist from previous test').toBeTruthy();
    const user = registeredUser!;

    await page.goto('/login');
    await page.getByTestId('login-email').fill(user.email);
    await page.getByTestId('login-password').fill('Definitely!Wrong!99');
    await page.getByTestId('login-submit').click();

    // Error banner appears and the user stays on the login page.
    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page.getByTestId('route-login')).toBeVisible();
  });
});
