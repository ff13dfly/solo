import { test, expect } from '@playwright/test';
import { mockMobile } from '../../helpers/mobile';

// The Focus card is the WRITE gate: a write-shaped intent does NOT auto-run (unlike a read,
// see view-list.spec.ts). It collects params, shows a summary card, and fires only when the
// user clicks 确认执行. These tests pin that gate — route-mocked, so no LLM/mesh/Redis.
//
// agent.purpose MUST be in caps or the client short-circuits ("AI 引擎尚未挂载").
const CAPABILITIES = {
  'agent.purpose': { desc: 'intent detection', ai: true },
  'agent.focus': { desc: 'param extraction', ai: true },
  // verb = create → NOT a READ_VERB → routed through the confirm gate.
  'planner.todo.create': {
    desc: '新建待办',
    params: [{ name: 'name', type: 'string', required: true, description: '待办内容' }],
    ai: true,
  },
};

// Wire the mock + a node-side tracker for the write method (route handlers run in node, so
// the test can assert exactly when/whether the write executed).
async function setupCreate(page: import('@playwright/test').Page) {
  const createCalls: any[] = [];
  await mockMobile(page, {
    capabilities: CAPABILITIES,
    handlers: {
      'agent.purpose': () => ({ id: 'planner.todo.create', confidence: 0.95, params: { name: '买牛奶' } }),
      // params already complete → extraction returns nothing; status stays 'pending'.
      'agent.focus': () => ({ extracted_params: {}, confidence: {}, hint: '请确认后执行', action: null }),
      'planner.todo.create': (params: any) => {
        createCalls.push(params);
        return { id: 't-new', name: params?.name, status: 'ACTIVE' };
      },
    },
  });
  return { createCalls };
}

async function openIntent(page: import('@playwright/test').Page, text = '新建待办 买牛奶') {
  await page.goto('/');
  // The app resets messages ~500ms after mount (registration prompt). Wait for it before typing.
  await expect(page.getByText('完善个人信息')).toBeVisible({ timeout: 10_000 });
  await typeMessage(page, text); // mock ignores routing text; agent.purpose is pinned to the create intent
}

async function typeMessage(page: import('@playwright/test').Page, text: string) {
  const input = page.locator('[data-test="chat-input"]');
  await input.fill(text);
  await input.press('Enter');
}

test.describe('mobile · focus card (write confirm gate, route-mocked)', () => {
  test('a write intent shows the confirm card and does NOT auto-execute', async ({ page }) => {
    const { createCalls } = await setupCreate(page);
    await openIntent(page);

    const card = page.locator('.summary-card');
    await expect(card.locator('.btn-confirm')).toBeVisible({ timeout: 10_000 }); // ✓ 确认执行
    await expect(card.getByText('新建待办')).toBeVisible();   // workflow name
    await expect(card.getByText('买牛奶')).toBeVisible();     // collected param

    // THE point: a write waits for the user — it has not fired (a read would have auto-run).
    expect(createCalls, 'write must not execute before confirm').toHaveLength(0);
  });

  test('确认执行 runs the write exactly once, then shows completion', async ({ page }) => {
    const { createCalls } = await setupCreate(page);
    await openIntent(page);

    const card = page.locator('.summary-card');
    await expect(card.locator('.btn-confirm')).toBeVisible({ timeout: 10_000 });
    await card.locator('.btn-confirm').click();

    // Definitive: the write executed once with the collected param…
    await expect.poll(() => createCalls.length, { timeout: 10_000 }).toBe(1);
    expect(createCalls[0]).toMatchObject({ name: '买牛奶' });
    // …and a persistent success message lands (the card's "操作完成" auto-resets after 2s;
    // finishExecution renders "✅ <name>已成功执行！" into chat history, which does not).
    await expect(page.getByText('已成功执行')).toBeVisible({ timeout: 5_000 });
  });

  test('取消 aborts without executing the write', async ({ page }) => {
    const { createCalls } = await setupCreate(page);
    await openIntent(page);

    const card = page.locator('.summary-card');
    await expect(card.locator('.btn-cancel')).toBeVisible({ timeout: 10_000 });
    await card.locator('.btn-cancel').click();

    await expect(page.locator('.summary-card .btn-confirm')).toHaveCount(0); // card dismissed
    expect(createCalls, 'cancel must not execute the write').toHaveLength(0);
  });

  test('multi-turn: a missing param is collected on a follow-up turn, then executes', async ({ page }) => {
    const createCalls: any[] = [];
    await mockMobile(page, {
      capabilities: CAPABILITIES,
      handlers: {
        'agent.purpose': () => ({ id: 'planner.todo.create', confidence: 0.95, params: {} }), // no name → collecting
        // Extraction dispatched by the user's turn: only the follow-up that says 买牛奶 fills `name`.
        'agent.focus': (params: any) =>
          String(params?.user_input || '').includes('买牛奶')
            ? { extracted_params: { name: '买牛奶' }, confidence: { name: 0.9 }, hint: '好的', action: null }
            : { extracted_params: {}, confidence: {}, hint: '请问待办内容是什么？', action: null },
        'planner.todo.create': (p: any) => { createCalls.push(p); return { id: 't-new', name: p?.name }; },
      },
    });
    await openIntent(page, '新建一个待办'); // no value yet → focus enters 'collecting'

    const card = page.locator('.summary-card');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('待填写')).toBeVisible();       // required field still empty
    await expect(card.locator('.btn-confirm')).toHaveCount(0);  // no confirm while collecting

    // Follow-up turn supplies the value → focus completes → confirm appears (still not fired).
    await typeMessage(page, '买牛奶');
    await expect(card.locator('.btn-confirm')).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('买牛奶')).toBeVisible();
    expect(createCalls).toHaveLength(0);

    await card.locator('.btn-confirm').click();
    await expect.poll(() => createCalls.length, { timeout: 10_000 }).toBe(1);
    expect(createCalls[0]).toMatchObject({ name: '买牛奶' });
  });

  test('error: a failed write shows 重试 and no success message', async ({ page }) => {
    const createCalls: any[] = [];
    await mockMobile(page, {
      capabilities: CAPABILITIES,
      handlers: {
        'agent.purpose': () => ({ id: 'planner.todo.create', confidence: 0.95, params: { name: '买牛奶' } }),
        'agent.focus': () => ({ extracted_params: {}, confidence: {}, hint: '请确认', action: null }),
        // Server rejects the write → confirmExecution throws → focus card goes to 'failed'.
        'planner.todo.create': (p: any) => { createCalls.push(p); return { status: 'failed', error: '库存不足' }; },
      },
    });
    await openIntent(page);

    const card = page.locator('.summary-card');
    await expect(card.locator('.btn-confirm')).toBeVisible({ timeout: 10_000 });
    await card.locator('.btn-confirm').click();

    // The write was attempted once but failed → card offers 重试, and there is NO success message
    // (the failed card does not auto-reset, unlike the completed one).
    await expect.poll(() => createCalls.length, { timeout: 10_000 }).toBe(1);
    await expect(card.locator('.btn-retry')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('已成功执行')).toHaveCount(0);
  });
});
