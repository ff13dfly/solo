# Mobile Client Playwright E2E 测试指南

## 概述

使用 Playwright 进行端到端测试，验证完整用户流程。

---

## 安装

```bash
cd client/mobile

# 安装 Playwright
yarn add -D @playwright/test

# 安装浏览器
yarn playwright install
```

---

## 配置

### playwright.config.ts

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  // 自动启动 dev server
  webServer: {
    command: 'yarn dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
```

---

## 目录结构

```
client/mobile/
├── tests/
│   └── e2e/
│       ├── focus.spec.ts        # Focus 流程测试
│       ├── login.spec.ts        # 登录流程测试
│       ├── chat.spec.ts         # 聊天功能测试
│       └── fixtures/
│           └── mocks.ts         # Mock 数据
│
├── playwright.config.ts
└── package.json
```

---

## 测试用例示例

### tests/e2e/focus.spec.ts

```typescript
import { test, expect } from '@playwright/test';

test.describe('Focus 流程', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // 等待应用加载
    await page.waitForSelector('[data-testid="chat-input"]');
  });

  test('输入 :f 进入 Focus 模式', async ({ page }) => {
    // 1. 输入 :f 前缀触发 Focus
    const input = page.locator('[data-testid="chat-input"]');
    await input.fill(':f 预定会议');
    await input.press('Enter');

    // 2. 验证 SummaryCard 出现
    await expect(page.locator('.summary-card')).toBeVisible({ timeout: 5000 });
    
    // 3. 验证工作流名称显示
    await expect(page.locator('.workflow-name')).toContainText('安排项目会议');
  });

  test('Focus 参数提取', async ({ page }) => {
    // 进入 Focus
    await page.fill('[data-testid="chat-input"]', ':f 预定会议');
    await page.keyboard.press('Enter');
    await expect(page.locator('.summary-card')).toBeVisible();

    // 输入参数
    await page.fill('[data-testid="chat-input"]', '三楼大厅');
    await page.keyboard.press('Enter');

    // 验证参数被填充
    await expect(page.locator('.param-row.filled')).toBeVisible();
    await expect(page.locator('.param-value')).toContainText('三楼大厅');
  });

  test('Focus 取消操作', async ({ page }) => {
    // 进入 Focus
    await page.fill('[data-testid="chat-input"]', ':f 预定会议');
    await page.keyboard.press('Enter');
    await expect(page.locator('.summary-card')).toBeVisible();

    // 点击取消
    await page.click('.close-btn');

    // 验证 SummaryCard 消失
    await expect(page.locator('.summary-card')).not.toBeVisible();
  });

  test('Focus 确认执行', async ({ page }) => {
    // 进入 Focus
    await page.fill('[data-testid="chat-input"]', ':f 预定会议');
    await page.keyboard.press('Enter');

    // 填充所有参数 (模拟 pending 状态)
    await page.fill('[data-testid="chat-input"]', '三楼大厅，明天下午三点');
    await page.keyboard.press('Enter');

    // 等待 pending 状态
    await expect(page.locator('.summary-card.status-pending')).toBeVisible({ timeout: 10000 });

    // 点击确认
    await page.click('.btn-confirm');

    // 验证执行中或完成
    await expect(page.locator('.summary-card.status-executing, .summary-card.status-completed'))
      .toBeVisible({ timeout: 10000 });
  });

});
```

### tests/e2e/chat.spec.ts

```typescript
import { test, expect } from '@playwright/test';

test.describe('聊天功能', () => {

  test('发送文本消息', async ({ page }) => {
    await page.goto('/');
    
    const input = page.locator('[data-testid="chat-input"]');
    await input.fill('你好');
    await input.press('Enter');

    // 验证用户消息出现
    await expect(page.locator('.message-bubble.user')).toContainText('你好');
    
    // 验证系统响应
    await expect(page.locator('.message-bubble.system')).toBeVisible({ timeout: 10000 });
  });

  test('Purpose 意图识别', async ({ page }) => {
    await page.goto('/');
    
    await page.fill('[data-testid="chat-input"]', ':p 帮我查一下库存');
    await page.keyboard.press('Enter');

    // 验证 loading 状态
    await expect(page.getByText('正在分析意图')).toBeVisible();

    // 验证结果显示
    await expect(page.getByText('识别到的能力')).toBeVisible({ timeout: 15000 });
  });

});
```

---

## Mock API

### tests/e2e/fixtures/mocks.ts

```typescript
import { Page } from '@playwright/test';

export async function mockAgentFocus(page: Page) {
  await page.route('**/api/rpc', async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    
    if (body.method === 'agent.focus') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            extracted_params: { roomId: '三楼大厅' },
            confidence: { roomId: 0.95 },
            hint: '好的，会议室选三楼大厅！请问您希望几点开始？',
            action: null
          }
        })
      });
    } else {
      await route.continue();
    }
  });
}
```

**使用 Mock**:

```typescript
test('Focus with mock', async ({ page }) => {
  await mockAgentFocus(page);
  await page.goto('/');
  // ...测试代码
});
```

---

## 运行测试

```bash
# 运行所有测试
yarn test:e2e

# 运行特定文件
yarn playwright test tests/e2e/focus.spec.ts

# 带 UI 模式运行 (调试用)
yarn test:e2e:ui

# 指定浏览器
yarn playwright test --project="Mobile Chrome"

# 生成报告
yarn test:e2e:report
```

---

## package.json 脚本

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:report": "playwright show-report"
  }
}
```

---

## data-testid 规范

为确保测试稳定性，组件应添加 `data-testid` 属性：

| 组件 | testid |
|:---|:---|
| 聊天输入框 | `chat-input` |
| 发送按钮 | `send-btn` |
| 消息气泡 | `message-{id}` |
| SummaryCard 确认按钮 | `focus-confirm` |
| SummaryCard 取消按钮 | `focus-cancel` |

---

## CI 集成

```yaml
# .github/workflows/e2e.yml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: cd client/mobile && yarn install --frozen-lockfile
      
      - name: Install Playwright Browsers
        run: cd client/mobile && yarn playwright install --with-deps
      
      - name: Run E2E tests
        run: cd client/mobile && yarn test:e2e
      
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: client/mobile/playwright-report/
```

---

## 调试技巧

```bash
# 调试模式 (暂停在每个步骤)
PWDEBUG=1 yarn test:e2e

# 录制测试脚本
yarn playwright codegen http://localhost:5173

# 查看跟踪文件
yarn playwright show-trace trace.zip
```

---

## 与 Storybook 对比

| 维度 | Playwright | Storybook |
|:---|:---|:---|
| **测试范围** | 完整应用流程 | 单个组件 |
| **真实度** | 真实浏览器 + API | Mock 数据 |
| **速度** | 较慢 (启动浏览器) | 较快 |
| **适用场景** | 用户流程验证 | UI 样式验证 |

**建议**: 两者配合使用，Storybook 开发时验证组件，Playwright CI 时验证流程。

---

## 参考

- [Playwright 官方文档](https://playwright.dev/docs/intro)
- [Mobile 测试](https://playwright.dev/docs/emulation#devices)
- [Mock API](https://playwright.dev/docs/mock)
