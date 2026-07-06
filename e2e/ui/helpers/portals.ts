import { Page, Locator, expect } from '@playwright/test';

/**
 * Page objects — the septopus selector-discipline pattern.
 *
 * Portal UI is i18n'd (button labels come from `t('login.submit')`), so text/role
 * selectors are localization-fragile and break on copy changes. The convention is a
 * stable `data-testid` contract owned by the page object, NOT scattered raw selectors
 * across specs. Both portals expose the SAME login testids
 * (login-form / login-username / login-password / login-submit), so one LoginPage drives
 * either — see portal/{system,operator}/src/pages/Login.tsx.
 *
 * Adding a new screen: give its key elements `data-testid`s and add a page object here;
 * specs talk to the page object, never to raw selectors.
 */
export class PortalPage {
  constructor(protected readonly page: Page) {}
  byId(id: string): Locator { return this.page.getByTestId(id); }
}

export class LoginPage extends PortalPage {
  get form() { return this.byId('login-form'); }
  get username() { return this.byId('login-username'); }
  get password() { return this.byId('login-password'); }
  get submit() { return this.byId('login-submit'); }

  /** Open /login and wait for the form to be interactive. */
  async open() {
    await this.page.goto('/login');
    await expect(this.form).toBeVisible();
  }

  /** Fill credentials and submit. */
  async login(user: string, pass: string) {
    await this.username.fill(user);
    await this.password.fill(pass);
    await this.submit.click();
  }
}
