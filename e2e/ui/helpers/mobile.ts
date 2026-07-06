import type { Page } from '@playwright/test';

const MOCK_ROUTER = 'http://solo-mock.local/';

export type RpcHandlers = Record<string, (params: any) => unknown>;

export interface MockMobileOptions {
  /**
   * Capability map seeded into localStorage (`chat_capabilities`). MUST include
   * `agent.purpose` or the client short-circuits with "AI 引擎未挂载"
   * (useChatLogic guards on `caps['agent.purpose']`).
   */
  capabilities: Record<string, unknown>;
  /** JSON-RPC method → result value. Methods not listed get an empty `{}` result. */
  handlers: RpcHandlers;
}

/**
 * Wire a route-mocked, pre-authed mobile session:
 *   - seed an auth token + capability map into localStorage (skips the login flow),
 *   - pin the Router URL to a dummy origin (routerManager reads `window.__SOLO_ROUTER__`),
 *   - intercept every JSON-RPC POST and dispatch by `method` to `handlers`.
 *
 * No backend, no LLM, no mesh — the test controls every server reply. This is the right
 * level for pinning client UX/rendering (does a list render? does a read auto-run?) without
 * depending on the agent's NL accuracy or a live stack.
 */
export async function mockMobile(page: Page, opts: MockMobileOptions): Promise<void> {
  // Seed before any app script runs (device check + routerManager + useChatLogic read these
  // at startup). `e2e_bypass_mobile_check` is the app's own e2e hook (lib/device.ts) — without
  // it a desktop browser hits the "不支持桌面端访问" gate and never renders the chat.
  await page.addInitScript((data: { router: string; caps: Record<string, unknown> }) => {
    (window as unknown as { __SOLO_ROUTER__: string }).__SOLO_ROUTER__ = data.router;
    localStorage.setItem('e2e_bypass_mobile_check', 'true');
    localStorage.setItem('auth_token', 'e2e-mock-token');
    localStorage.setItem('chat_capabilities', JSON.stringify(data.caps));
  }, { router: MOCK_ROUTER, caps: opts.capabilities });

  // Intercept the JSON-RPC boundary regardless of the resolved router URL — match on the
  // request body (a POST carrying a `method`), let everything else (vite assets) through.
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();

    let body: { method?: string; id?: unknown; params?: unknown } | null = null;
    try { body = req.postDataJSON(); } catch { /* not a JSON body */ }
    if (!body || !body.method) return route.continue();

    const handler = opts.handlers[body.method];
    const result = handler ? handler((body.params as any) ?? {}) : {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result }),
    });
  });
}
