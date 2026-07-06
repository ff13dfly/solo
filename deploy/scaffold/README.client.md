# {{PROJECT_NAME}} — Clients

`client/` 存放面向**终端用户**的外部应用，与 `portal/`（内部运营工具）相对。

---

## 目录结构

```
client/
├── publish/               预构建 bundle（mobile 由 run.sh 自动 serve）
│   └── mobile.v{{SOLO_VERSION}}.tar.gz
├── mobile/                移动端 / PWA 源码（Solo 源码树中开发）
├── plugin/                插件（各插件独立子目录，独立开发发布）
└── README.md
```

> **desktop 不在脚手架范围内。** 桌面端应用独立开发、独立发布，不通过 `run.sh` 管理。

---

## mobile — 移动端 / PWA

`client/mobile` 以**预构建 bundle** 分发，`run.sh` 启动时自动解压并 serve。

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `CLIENT_MOBILE_PORT` | 3010 | serve 端口，在 `.env` 中配置 |

### Bundle 管理

`init.sh` 默认从 Solo **当下源码**构建并下发当前版本 bundle（版本钉 `.solo-version`），无需手动准备：

- `FRONTEND_BUILD=auto`（默认）当前版本 tarball 缺失就自动构建
- `FRONTEND_BUILD=force` 强制重新构建
- `FRONTEND_BUILD=skip` 不构建，只发已存在的当前版本 tarball

后续手动升级：

```bash
# 在 Solo 源码目录重新构建（自动清掉同名旧版本 tarball）
bash deploy/build-frontend.sh

# 复制到本项目 + 对齐 .solo-version，重启
cp client/publish/mobile.v{version}.tar.gz /path/to/{{PROJECT_NAME}}/client/publish/
echo "v{version}" > /path/to/{{PROJECT_NAME}}/.solo-version
bash deploy/run.sh
```

### 独立开发

```bash
cd client/mobile
npm install
npm run dev     # 本地开发
npm run build   # 构建
```

**约定**：
- API 请求走 `window.__SOLO_ROUTER__`（由 `run.sh` 注入 `config.js`）
- `index.html` 须在主 bundle 前加载 `/config.js`：
  ```html
  <script src="/config.js"></script>
  ```

---

## plugin — 插件

插件完全独立开发，不通过 `run.sh` 管理。每个插件一个子目录，独立 `package.json`、独立发布渠道。

```
client/plugin/
└── <plugin-name>/
    ├── package.json
    └── src/
```

---

## 与后端通信

所有 Client 均通过 **Router（port 8484）** 的 JSON-RPC 2.0 接口与后端通信。

```
client → Router:8484 → 微服务
```

认证：JWT，由 `administrator` 服务签发，携带在 `Authorization: Bearer <token>` 头中。
