# Mobile Client Storybook 测试指南

## 概述

使用 Storybook 进行组件可视化测试，验证 UI 在不同状态下的表现。

---

## 安装

```bash
cd client/mobile

# 安装 Storybook (Vite 版)
npx storybook@latest init --builder @storybook/builder-vite
```

安装完成后目录结构：

```
client/mobile/
├── .storybook/
│   ├── main.ts          # Storybook 配置
│   └── preview.ts       # 全局样式/装饰器
├── src/
│   └── components/
│       └── focus/
│           ├── SummaryCard.tsx
│           └── SummaryCard.stories.tsx  # Story 文件
└── package.json
```

---

## 配置

### .storybook/main.ts

```typescript
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: [
    '@storybook/addon-links',
    '@storybook/addon-essentials',
    '@storybook/addon-interactions',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
};

export default config;
```

### .storybook/preview.ts

```typescript
import type { Preview } from '@storybook/react';
import '../src/index.css';  // 全局样式

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#f5f5f5' },
        { name: 'dark', value: '#1a1a1a' },
      ],
    },
    viewport: {
      viewports: {
        mobile: { name: 'Mobile', styles: { width: '375px', height: '667px' } },
        tablet: { name: 'Tablet', styles: { width: '768px', height: '1024px' } },
      },
      defaultViewport: 'mobile',
    },
  },
};

export default preview;
```

---

## 编写 Story

### 示例：SummaryCard.stories.tsx

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { SummaryCard } from './SummaryCard';
import type { FocusState } from '../../types/focus';

const meta: Meta<typeof SummaryCard> = {
  title: 'Focus/SummaryCard',
  component: SummaryCard,
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    onConfirm: { action: 'confirmed' },
    onCancel: { action: 'cancelled' },
  },
};

export default meta;
type Story = StoryObj<typeof SummaryCard>;

// ===== 状态变体 =====

// 1. 收集中状态
export const Collecting: Story = {
  args: {
    focusState: {
      status: 'collecting',
      workflowId: 'meeting_setup_v1',
      workflowDef: {
        id: 'meeting_setup_v1',
        name: '安排项目会议',
        required_inputs: ['roomId', 'startTime', 'duration'],
      },
      currentParams: { roomId: '三楼大厅' },
      missingFields: ['startTime', 'duration'],
      confidence: { roomId: 0.95 },
      hint: '好的，会议室选三楼大厅！请问您希望几点开始？',
      clarificationCount: 0,
      invalidInputCount: 0,
    } as FocusState,
  },
};

// 2. 待确认状态
export const Pending: Story = {
  args: {
    focusState: {
      status: 'pending',
      workflowId: 'meeting_setup_v1',
      workflowDef: {
        id: 'meeting_setup_v1',
        name: '安排项目会议',
        required_inputs: ['roomId', 'startTime', 'duration'],
      },
      currentParams: {
        roomId: '三楼大厅',
        startTime: '2026-01-10T15:00:00',
        duration: 60,
      },
      missingFields: [],
      confidence: { roomId: 0.95, startTime: 0.9, duration: 1.0 },
      hint: '信息已齐全：三楼大厅，明天下午3点，时长60分钟。确认后我将为您安排。',
      clarificationCount: 0,
      invalidInputCount: 0,
    } as FocusState,
  },
};

// 3. 执行中状态
export const Executing: Story = {
  args: {
    focusState: {
      status: 'executing',
      workflowId: 'meeting_setup_v1',
      workflowDef: {
        id: 'meeting_setup_v1',
        name: '安排项目会议',
        required_inputs: ['roomId', 'startTime', 'duration'],
      },
      currentParams: {
        roomId: '三楼大厅',
        startTime: '2026-01-10T15:00:00',
        duration: 60,
      },
      missingFields: [],
      confidence: {},
      hint: null,
      clarificationCount: 0,
      invalidInputCount: 0,
      executionProgress: 45,
    } as FocusState,
  },
};

// 4. 完成状态
export const Completed: Story = {
  args: {
    focusState: {
      status: 'completed',
      workflowId: 'meeting_setup_v1',
      workflowDef: {
        id: 'meeting_setup_v1',
        name: '安排项目会议',
        required_inputs: ['roomId', 'startTime', 'duration'],
      },
      currentParams: {
        roomId: '三楼大厅',
        startTime: '2026-01-10T15:00:00',
        duration: 60,
      },
      missingFields: [],
      confidence: {},
      hint: null,
      clarificationCount: 0,
      invalidInputCount: 0,
      executionProgress: 100,
    } as FocusState,
  },
};

// 5. 失败状态
export const Failed: Story = {
  args: {
    focusState: {
      status: 'failed',
      workflowId: 'meeting_setup_v1',
      workflowDef: {
        id: 'meeting_setup_v1',
        name: '安排项目会议',
        required_inputs: ['roomId', 'startTime'],
      },
      currentParams: { roomId: '三楼大厅' },
      missingFields: [],
      confidence: {},
      hint: null,
      clarificationCount: 0,
      invalidInputCount: 0,
      errorMessage: '会议室已被预定，请选择其他时间',
    } as FocusState,
  },
};
```

---

## 运行

```bash
# 启动 Storybook 开发服务器
yarn storybook

# 构建静态文件 (用于 CI/CD)
yarn build-storybook
```

默认端口: `http://localhost:6006`

---

## Story 命名规范

| 组件 | Story 文件 | Title |
|:---|:---|:---|
| `SummaryCard.tsx` | `SummaryCard.stories.tsx` | `Focus/SummaryCard` |
| `InputBar.tsx` | `InputBar.stories.tsx` | `Chat/InputBar` |
| `MessageBubble.tsx` | `MessageBubble.stories.tsx` | `Chat/MessageBubble` |

---

## 测试场景清单

### Focus 组件

| Story | 验证内容 |
|:---|:---|
| `Collecting` | 进度条显示 [1/3]，缺失字段虚线边框 |
| `Pending` | 确认按钮可见，所有字段 ✅ |
| `Executing` | 进度条动画，渐变色变化 |
| `Completed` | 完成消息显示 |
| `Failed` | 错误消息 + 重试按钮 |

### Chat 组件

| Story | 验证内容 |
|:---|:---|
| `TextMessage` | 文本气泡样式 |
| `ImageMessage` | 图片加载、点击放大 |
| `ChartMessage` | ECharts 渲染 |
| `SystemMessage` | 系统消息居中样式 |

---

## CI 集成

```yaml
# .github/workflows/storybook.yml
name: Storybook

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install
        run: cd client/mobile && yarn install --frozen-lockfile
      
      - name: Build Storybook
        run: cd client/mobile && yarn build-storybook
      
      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: client/mobile/storybook-static
```

---

## 常用命令

| 命令 | 说明 |
|:---|:---|
| `yarn storybook` | 启动开发服务器 |
| `yarn build-storybook` | 构建静态文件 |
| `yarn dlx storybook add @storybook/addon-a11y` | 添加无障碍检查插件 |

---

## 参考

- [Storybook 官方文档](https://storybook.js.org/docs/react/get-started/introduction)
- [Vite + React 配置](https://storybook.js.org/docs/react/builders/vite)
