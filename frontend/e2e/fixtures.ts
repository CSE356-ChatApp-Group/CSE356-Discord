import { test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { buildUser, ensureAuthenticated } from './helpers/session';
import type { TestUser } from './helpers/session';

export type { TestUser };

interface AuthFixtures {
  /**
   * A fully authenticated browser context with a page already loaded at the
   * chat route. Use this in tests that need a logged-in user from the start.
   *
   * Each test receives a fresh context + page with a newly registered user, so
   * tests are fully isolated from one another.
   */
  authed: {
    context: BrowserContext;
    page: Page;
    token: string;
    user: TestUser;
  };
}

export const test = base.extend<AuthFixtures>({
  authed: async ({ browser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const user = buildUser('usr');
    const token = await ensureAuthenticated(context, page, user);
    await use({ context, page, token, user });
    await context.close();
  },
});

export { expect } from '@playwright/test';
