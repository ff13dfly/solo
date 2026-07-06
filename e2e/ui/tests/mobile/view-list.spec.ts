import { test, expect } from '@playwright/test';
import { mockMobile } from '../../helpers/mobile';

// agent.purpose MUST be present in the seeded caps or the client refuses to call it
// (useChatLogic guards on caps['agent.purpose'] → "AI 引擎尚未挂载").
const CAPABILITIES = {
  'agent.purpose': { desc: 'intent detection', ai: true },
  'planner.todo.list': { desc: '列出待办', params: [], ai: true, returns: ['items'] },
};

const TODOS = [
  { id: 't1', name: '买牛奶' },
  { id: 't2', name: '写周报' },
];

test.describe('mobile · view/list UX (route-mocked)', () => {
  test.beforeEach(async ({ page }) => {
    await mockMobile(page, {
      capabilities: CAPABILITIES,
      handlers: {
        // NL → a read intent, fully specified (nothing to collect).
        'agent.purpose': () => ({ id: 'planner.todo.list', confidence: 0.97, params: {} }),
        'agent.focus': () => ({ extracted_params: {}, confidence: {}, hint: '好的', action: null }),
        // the read itself returns a list of items.
        'planner.todo.list': () => ({ items: TODOS }),
      },
    });
  });

  // RED until the client renders read results inline + auto-runs read-shaped intents.
  // Today a read is forced through the write-shaped confirm gate and, on execute, collapses
  // to "✅ 已成功执行" while the items vanish into operational memory (never rendered).
  test('a list query surfaces its results as a visible list, not a success toast', async ({ page }) => {
    await page.goto('/');

    // The app resets messages ~500ms after mount (registration prompt for an un-seeded
    // profile). Wait for that to land before typing so our message isn't wiped by the race.
    // (single-match locator — the 开始使用 button would trip strict mode)
    await expect(page.getByText('完善个人信息')).toBeVisible({ timeout: 10_000 });

    const input = page.locator('[data-test="chat-input"]');
    await input.fill('列出我的待办');
    await input.press('Enter');

    // Desired UX: the read auto-runs and renders its items inline.
    await expect(page.locator('[data-test="result-list"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('买牛奶')).toBeVisible();
    await expect(page.getByText('写周报')).toBeVisible();

    // …and is NOT reduced to a write-style success toast.
    await expect(page.getByText('已成功执行')).toHaveCount(0);
  });
});
