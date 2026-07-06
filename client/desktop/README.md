# Solo Desktop Client (Desktop)

`client/desktop` 是 Solo 系统的**高生产力指挥中心**。它专为大屏幕、高频操作以及深度沉浸式工作设计，旨在复现 macOS 原生应用级别的交互流畅度。

## 1. 定位与愿景

在 Solo 客户端矩阵中，Desktop 承担着“深度工作”的职责：
- **Mobile**：重语音，轻量级意图捕捉，适合移动场景。
- **Desktop**：重操作，大画布流程编排，适合桌面办公。

`planner` (效能规划) 是 Desktop 客户端的首个核心应用场景。

## 2. 交互设计准则 (UX Principles)

为了达到“Mac 级”体验，桌面端必须实现以下特性：
- **极致流畅 (Butter Smooth)**：使用 GPU 加速的动画库（如 Framer Motion），模拟物理世界的弹性转场（Spring Physics）。
- **零延迟感 (Optimistic UI)**：所有修改先在本地 UI 生效，后端异步同步。即使在离线状态下也应能流畅操作。
- **专业布局**：利用大屏幕空间，实现日历时间块（Agenda）与 Markdown 编辑器（Todo）的双向分栏联动。
- **系统集成**：深度集成系统级通知、菜单栏快捷入口以及全局快捷键支持。

## 3. 已确定的功能场景：Planner (规划者)

基于 `api/apps/planner` 微服务，桌面端将实现：

### 3.1 时间块日历 (Mac Style Calendar)
- **多维视图**：支持日、周、月以及“项目态势”视图。
- **交互拖拽**：支持通过拖拽调整日程时长和发生时间，支持碰撞检测与自动避让。
- **# 符号关联**：在创建日程标题时，自动识别并联想 `#` 后的 Todo 项目。

### 3.2 深度 Markdown 空间
- **沉浸式编辑**：支持实时预览的 Markdown 编辑器，直接读写 Redis 中的 Todo 内容。
- **上下文关联**：在 Markdown 文档中，AI 会自动高亮关联的日程记录。

### 3.3 AI 态势仪表盘
- **视觉化覆盖层**：AI 分析的结果（如进度热力图、风险色块）将作为一层 Overlay 直接覆盖在日历或任务列表上。
- **主动干预**：AI 可以在侧边栏弹出建议：“检测到项目进度滞后 15%，建议将下周二的非关键会议改为异步沟通。”

## 4. 技术栈路线 (Proposed Tech Stack)

- **框架**: [Tauri](https://tauri.app/) (首选) 或 Electron + Next.js。
- **UI**: TailwindCSS + Framer Motion + Shadcn/UI (适配桌面版)。
- **通讯**: 采用标准 **JSON-RPC Over HTTP** (System API)。目前优先保证桌面端本地逻辑处理的严整性，暂不引入 WebSocket 等实时同步层。
- **存储约束**: Markdown 编辑器严禁直接嵌入二进制 Base64 数据；所有附件通过桌面端调起系统上传接口后的 URL 进行引用，确保 Redis 性能。

## 5. 打包与发布 (Build & Package)

### 5.1 环境准备
在打包前，请确保系统已安装：
- **Node.js**: 用于前端构建。
- **Rust**: 用于后端编译 (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)。
- **依赖安装**: 在本目录下运行 `npm install`。

### 5.2 打包命令
运行以下命令生成 macOS 生产环境安装包 (`.app` 和 `.dmg`)：
```bash
npx tauri build
```
打包产物位于：`src-tauri/target/release/bundle/macos/`

## 6. 开发与调试 (Development & Debugging)

为了方便快速迭代，系统提供了一键启动脚本，支持在浏览器和原生窗口之间切换：

### 6.1 启动全栈环境
在项目根目录下运行脚本：

- **浏览器模式 (默认)**:
  ```bash
  ./deploy/dev.sh
  ```
  该模式会在 [http://localhost:1420](http://localhost:1420) 启动网页版桌面端，支持常规浏览器调试工具。

- **原生桌面模式**:
  ```bash
  ./deploy/dev.sh native
  ```
  该模式会调起真正的 **Tauri 原生窗口**，用于测试原生交互、托盘图标或系统级 API。

---

## 7. 图标管理 (Icon Management)

由于 Tauri 打包过程需要特定的图标格式（`.icns` 和 `.ico`），请按照以下步骤更新或重新生成图标：

1. **准备源文件**: 确保 `src-tauri/icons/source.png` 存在（必须是 1024x1024 的正方形）。
2. **格式修正 (macOS)**: 
   如果源文件实际是 JPEG 格式但扩展名为 `.png`，需要先进行转换（Tauri 仅支持读取真实的 PNG）：
   ```bash
   sips -s format png src-tauri/icons/source.png --out src-tauri/icons/source_real.png
   ```
3. **一键生成图标库**:
   ```bash
   npm run tauri -- icon src-tauri/icons/source_real.png
   ```
   该命令会自动在 `src-tauri/icons` 目录下生成所有平台所需的各种尺寸图标。

---

> [!NOTE]
> 本客户端优先考虑 macOS 平台的视觉与交互标准，未来可扩展至 Windows/Linux。

---

## 8. UI 架构与插件隔离 (UI Architecture & Plugin Isolation)

为了确保插件系统的可维护性与 UI 一致性，桌面端采用了以下样式策略：

### 8.1 样式依赖现状 (Upward Dependency)
目前插件（Plugins）在构建时共享主程序的 `tailwind.config.ts`。
- **优点**：插件可以直接使用所有标准 Tailwind 类，体积小，响应快。
- **限制**：插件样式“向上依赖”于宿主程序的编译环境。如果宿主程序缺少某个类名的定义，插件的对应样式将失效。

### 8.2 UI SDK 模式 (Experimental)
为了彻底解耦，我们正在引入 **UI SDK 注入模式**：
- **组件注入**：主程序将一组预置了样式、交互的原子组件（如 `Card`, `Button`, `Input`）通过上下文注入插件。
- **插件调用**：插件不再直接编写复杂的 Tailwind 类名，而是通过 `<SDK.Card>` 等方式调用。
- **目标**：实现“一次编写，到处运行”。插件逻辑与样式彻底解耦，确保在不同宿主环境（Desktop/Mobile）下都能维持一致的视觉表现。

> [!IMPORTANT]
> 在开发新插件时，优先使用 `src/App.tsx` 中定义的 `SoloSDK` 属性，避免直接编写特定于主程序的辅助类名。
