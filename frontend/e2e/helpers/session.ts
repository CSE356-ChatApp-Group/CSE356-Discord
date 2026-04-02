import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

export type TestUser = {
  username: string;
  displayName: string;
  email: string;
  password: string;
};

const AUTH_RETRY_ATTEMPTS = 2;
const AUTH_RETRY_DELAY_MS = 400;
const AUTH_MIN_INTERVAL_MS = 250;
let lastAuthRequestAt = 0;

export async function waitForAuthSlot() {
  const now = Date.now();
  const elapsed = now - lastAuthRequestAt;
  const waitMs = AUTH_MIN_INTERVAL_MS - elapsed;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastAuthRequestAt = Date.now();
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildUser(prefix: string): TestUser {
  const suffix = uniqueSuffix();
  return {
    username: `${prefix}_${suffix}`,
    displayName: `${prefix} ${suffix}`,
    email: `${prefix}.${suffix}@e2e.local`,
    password: 'Passw0rd!e2e',
  };
}

export async function registerOrLogin(request: APIRequestContext, user: TestUser) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= AUTH_RETRY_ATTEMPTS; attempt += 1) {
    await waitForAuthSlot();
    const register = await request.post('/api/v1/auth/register', {
      data: {
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        password: user.password,
      },
      timeout: 10_000,
    });

    const registerStatus = register.status();
    if (register.ok()) {
      const body = await register.json().catch(() => ({}));
      const token = body?.accessToken;
      if (token) return token as string;
    }
    lastStatus = registerStatus;

    await waitForAuthSlot();
    const login = await request.post('/api/v1/auth/login', {
      data: {
        email: user.email,
        password: user.password,
      },
      timeout: 10_000,
    });

    const loginStatus = login.status();
    if (login.ok()) {
      const body = await login.json().catch(() => ({}));
      const token = body?.accessToken;
      if (token) return token as string;
    }
    lastStatus = loginStatus;

    const transientRateLimit =
      registerStatus === 429 ||
      registerStatus === 503 ||
      loginStatus === 429 ||
      loginStatus === 503;

    if (attempt < AUTH_RETRY_ATTEMPTS && transientRateLimit) {
      await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAY_MS * attempt));
      continue;
    }
    break;
  }

  expect(false, `register/login failed for ${user.username}, last status ${lastStatus}`).toBeTruthy();
  return '';
}

export async function ensureUserExists(request: APIRequestContext, user: TestUser) {
  return await registerOrLogin(request, user);
}

export async function findExistingUsername(
  request: APIRequestContext,
  excludedUsernames: string[]
) {
  const excluded = new Set(excludedUsernames.map((value) => value.toLowerCase()));
  const probes = ['a', 'e', 'i', 'o', 'u', 'dev', 'user', 'chat'];

  for (const probe of probes) {
    const res = await request.get(`/api/v1/users?q=${encodeURIComponent(probe)}`, { timeout: 10_000 });
    if (!res.ok()) continue;

    const data = await res.json().catch(() => ({}));
    const users = (data?.users ?? data ?? []) as Array<{ username?: string }>;
    const match = users.find((user) => {
      const username = (user?.username || '').toLowerCase();
      return username && !excluded.has(username);
    });
    if (match?.username) return match.username;
  }

  return null;
}

export async function bootstrapPageWithToken(page: Page, token: string) {
  // The app's init() fires on every mount and calls the refresh endpoint.
  // Under rapid sequential tests that endpoint can still be briefly throttled
  // (503), causing RequireAuth to redirect to /login before user state is set.
  // Retrying the navigation gives the rate-limiter time to clear.
  const BOOTSTRAP_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    await page.goto(`/oauth-callback?token=${encodeURIComponent(token)}`);
    const chatRoute = page.getByTestId('route-chat');
    const ok = await chatRoute.isVisible({ timeout: 10_000 }).catch(() => false);
    if (ok) return;
    if (attempt < BOOTSTRAP_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1_200 * attempt));
    }
  }
  // Final assert to produce a clear failure message if still not visible.
  await expect(page.getByTestId('route-chat')).toBeVisible();
}

export async function loginViaUiWithRetry(page: Page, user: TestUser) {
  const identifiers = [user.username, user.email].filter(Boolean);

  for (const [index, loginIdentifier] of identifiers.entries()) {
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    await expect(
      page.locator('[data-testid="route-login"], [data-testid="route-chat"]'),
    ).toBeVisible({ timeout: 20_000 });

    const alreadyLoggedIn = await page.getByTestId('route-chat').isVisible({ timeout: 1_000 }).catch(() => false);
    if (alreadyLoggedIn) return;

    await expect(page.getByTestId('route-login')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('login-email').fill(loginIdentifier);
    await page.getByTestId('login-password').fill(user.password);

    const loginResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/v1/auth/login'),
      { timeout: 15_000 },
    ).catch(() => null);

    await page.getByTestId('login-submit').click();

    const loginResponse = await loginResponsePromise;
    const loginStatus = loginResponse?.status() ?? 0;

    if (loginStatus === 429 || loginStatus === 503) {
      await new Promise((r) => setTimeout(r, 1_500 * (index + 1)));
      continue;
    }

    await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 }).catch(() => {});

    const loggedIn = await page.getByTestId('route-chat').isVisible({ timeout: 20_000 }).catch(() => false);
    if (loggedIn) return;

    const invalidCredentials = await page
      .getByTestId('login-error')
      .filter({ hasText: 'Invalid credentials' })
      .isVisible({ timeout: 1_000 })
      .catch(() => false);

    if (invalidCredentials) {
      continue;
    }
  }

  await expect(page.getByTestId('route-chat')).toBeVisible({ timeout: 20_000 });
}

export async function ensureAuthenticated(context: BrowserContext, page: Page, user: TestUser): Promise<string> {
  const token = await registerOrLogin(context.request, user);
  // Briefly yield so the callback navigation can settle before hydration.
  await new Promise((r) => setTimeout(r, 100));
  try {
    await bootstrapPageWithToken(page, token);
  } catch {
    // Fallback for transient auth API throttling during bootstrap.
    await loginViaUiWithRetry(page, user);
  }
  return token;
}

export async function createGroupAndInvite(
  request: APIRequestContext,
  initialParticipants: string[],
  invitedParticipant: string,
  accessToken?: string,
) {
  const headers = accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : undefined;

  const created = await request.post('/api/v1/conversations', {
    data: {
      participantIds: initialParticipants,
    },
    headers,
    timeout: 10_000,
  });

  const createdBody = await created.json().catch(() => ({}));
  expect(
    created.ok(),
    `failed to create group conversation (${created.status()}): ${JSON.stringify(createdBody)}`,
  ).toBeTruthy();
  const conversationId = createdBody?.conversation?.id;
  expect(Boolean(conversationId), 'conversation id missing').toBeTruthy();

  const invited = await request.post(`/api/v1/conversations/${conversationId}/invite`, {
    data: {
      participantIds: [invitedParticipant],
    },
    headers,
    timeout: 10_000,
  });

  const inviteBody = await invited.json().catch(() => ({}));
  expect(
    invited.ok(),
    `failed to send invite (${invited.status()}): ${JSON.stringify(inviteBody)}`,
  ).toBeTruthy();
  return conversationId as string;
}

export async function waitForSidebar(page: Page) {
  await expect(
    page.locator('[data-testid="channel-sidebar"], [data-testid="channel-sidebar-empty"]')
  ).toBeVisible();
}
