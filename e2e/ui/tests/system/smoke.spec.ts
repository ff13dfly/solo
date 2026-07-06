import { test, expect } from '../../helpers/fixtures';
import path from 'path';

// Inject pre-acquired admin auth state (created by global-setup.ts).
test.use({ storageState: path.join(__dirname, '../../state/system.json') });

const PAGES = [
  { route: '/overview',   label: 'overview'    },
  { route: '/services',   label: 'services'    },
  { route: '/users',      label: 'users'       },
  { route: '/bots',       label: 'bots'        },
  { route: '/workflows',  label: 'workflows'   },
  { route: '/ingress',    label: 'ingress'     },
  { route: '/events',     label: 'event-bus'   },
  { route: '/nexus',      label: 'nexus'       },
  { route: '/automation', label: 'automation'  },
  { route: '/errors',     label: 'error-logs'  },
];

for (const { route, label } of PAGES) {
  test(`@smoke system:${label} — loads without redirect or crash`, async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', e => jsErrors.push(e.message));

    await page.goto(route);
    await page.waitForLoadState('networkidle');

    // Must stay authenticated — not bounced to /login.
    await expect(page).not.toHaveURL(/\/login/);

    // Body must be visible (no blank white screen).
    await expect(page.locator('body')).toBeVisible();

    expect(jsErrors, `JS errors on ${route}: ${jsErrors.join('; ')}`).toHaveLength(0);
  });
}
