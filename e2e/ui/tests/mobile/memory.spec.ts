import { test, expect, type Page } from '@playwright/test';
import { mockMobile } from '../../helpers/mobile';

// These tests assert on the `memory` param the client injects into each agent.purpose call
// (captured in the route-mock handler) — the actual behaviour under test — rather than DOM,
// so they're robust to styling. The client builds that string from useMemory.formatMemoryString.

const CAPS = {
  'agent.purpose': { desc: 'intent', ai: true },
  'planner.todo.list': { desc: '列出待办', params: [], ai: true, returns: ['items'] },
};
const TODO = { id: 't1', name: '买牛奶' };

// The app resets messages ~500ms after mount (registration prompt for an un-seeded profile);
// wait past it before driving so our messages aren't wiped by the race.
async function settle(page: Page) {
  // (single-match locator — the 开始使用 button would trip strict mode)
  await expect(page.getByText('完善个人信息')).toBeVisible({ timeout: 10_000 });
}
async function send(page: Page, text: string) {
  const input = page.locator('[data-test="chat-input"]');
  await input.fill(text);
  await input.press('Enter');
}

test.describe('mobile · focus memory (route-mocked)', () => {
  // STM — an entity surfaced in one turn is injected into the next purpose call.
  test('STM: an operational entity carries into the next turn', async ({ page }) => {
    const purpose: any[] = [];
    await mockMobile(page, {
      capabilities: CAPS,
      handlers: {
        'agent.purpose': (p) => { purpose.push(p); return { id: 'planner.todo.list', confidence: 0.97, params: {} }; },
        'planner.todo.list': () => ({ items: [TODO] }),
      },
    });
    await page.goto('/');
    await settle(page);

    await send(page, '列出我的待办');
    await expect(page.locator('[data-test="result-list"]')).toHaveCount(1, { timeout: 10_000 });

    await send(page, '再看看');
    await expect(page.locator('[data-test="result-list"]')).toHaveCount(2, { timeout: 10_000 });

    expect(purpose.length).toBeGreaterThanOrEqual(2);
    expect(String(purpose[1].memory)).toContain('买牛奶'); // operational STM injected
  });

  // LTM — re-referencing the same entity consolidates it into durable [Long-Term Memory].
  test('LTM: a re-referenced entity is promoted to long-term memory', async ({ page }) => {
    const purpose: any[] = [];
    await mockMobile(page, {
      capabilities: CAPS,
      handlers: {
        'agent.purpose': (p) => { purpose.push(p); return { id: 'planner.todo.list', confidence: 0.97, params: {} }; },
        'planner.todo.list': () => ({ items: [TODO] }),
      },
    });
    await page.goto('/');
    await settle(page);

    await send(page, '列出我的待办');
    await expect(page.locator('[data-test="result-list"]')).toHaveCount(1, { timeout: 10_000 });
    await send(page, '再列一次'); // 2nd reference → promote t1 to LTM
    await expect(page.locator('[data-test="result-list"]')).toHaveCount(2, { timeout: 10_000 });
    await send(page, '还有别的吗');
    await expect(page.locator('[data-test="result-list"]')).toHaveCount(3, { timeout: 10_000 });

    expect(purpose.length).toBeGreaterThanOrEqual(3);
    expect(String(purpose[2].memory)).toContain('[Long-Term Memory]');
    expect(String(purpose[2].memory)).toContain('买牛奶');
  });

  // Correction — a failed execution is remembered as a pending intent, then cleared on success.
  test('Correction: a failed run is remembered, then cleared on the next success', async ({ page }) => {
    const purpose: any[] = [];
    let todoCalls = 0;
    await mockMobile(page, {
      capabilities: CAPS,
      handlers: {
        'agent.purpose': (p) => { purpose.push(p); return { id: 'planner.todo.list', confidence: 0.97, params: {} }; },
        // first execution fails (→ setCorrection), later ones succeed (→ clearCorrection).
        'planner.todo.list': () => { todoCalls += 1; return todoCalls === 1 ? { status: 'failed', error: 'boom' } : { items: [TODO] }; },
      },
    });
    await page.goto('/');
    await settle(page);

    // Turn 1 fails → no result list; wait for the RPC, then let setCorrection settle.
    await send(page, '列出我的待办');
    await expect.poll(() => todoCalls, { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(400);

    // Turn 2's purpose carries the pending intent; the turn itself succeeds → clears it.
    await send(page, '再试一次');
    await expect(page.locator('[data-test="result-list"]')).toHaveCount(1, { timeout: 10_000 });

    // Turn 3 should no longer see the pending intent.
    await send(page, '还有吗');
    await expect(page.locator('[data-test="result-list"]')).toHaveCount(2, { timeout: 10_000 });

    expect(purpose.length).toBeGreaterThanOrEqual(3);
    expect(String(purpose[1].memory)).toContain('[Pending Intent]');
    expect(String(purpose[2].memory)).not.toContain('[Pending Intent]');
  });
});
