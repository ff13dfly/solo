# {{PROJECT_NAME}} — Portals

`portal/` 存放面向**内部运营人员**的管理工具，与 `client/`（面向终端用户的外部应用）相对。

---

## Operator Portal（源码，可定制）

`portal/operator/` 是完整的 Vite + React 源码项目，复制自 Solo 源码树，可以在本项目里直接修改 UI。

```bash
cd portal/operator
npm install
npm run dev        # 本地开发（Vite HMR，默认 http://localhost:5173）
npm run build      # 生产构建 → dist/
```

路由到 Router：`portal/operator/src/utils/routerManager.ts` 管理 Router 地址，默认读 `window.__SOLO_ROUTER__`（由 `run.sh` 注入），开发时可在 `.env.local` 里覆盖：

```
VITE_ROUTER_URL=http://localhost:8600
```

### 第一个 Operator 账号

启动 system portal 后，用 admin 登录，进入 **User Management → + Operator** 可一键创建 operator 账号（指定用户名+密码，自动设置权限）。

---

## System Portal（预构建 bundle）

`portal/system/` 系统管理台以预构建 bundle 分发，由 `run.sh` 解压并 serve，无需前端开发环境。

| Portal | 端口（默认） | 说明 |
|--------|-------------|------|
| operator | `PORTAL_OPERATOR_PORT`（3600） | 业务操作台（源码 Vite，独立 dev server） |
| system   | `PORTAL_SYSTEM_PORT`（3650）   | 系统管理台（预构建 bundle，由 run.sh 托管） |

---

## System Portal Bundle 升级

> 初始化时 `init.sh` 已默认从 Solo 当下源码构建并下发当前版本 bundle（`FRONTEND_BUILD=auto|force|skip`）。以下是后续手动升级到新版的步骤。

```bash
# 1. 在 Solo 源码目录重新构建（自动清掉同名旧版本 tarball）
bash deploy/build-frontend.sh

# 2. 复制新 bundle 到本项目
cp portal/publish/system.v{new}.tar.gz /path/to/{{PROJECT_NAME}}/portal/publish/

# 3. 更新 .solo-version（如 v{new}），重启
echo "v{new}" > /path/to/{{PROJECT_NAME}}/.solo-version
bash deploy/run.sh
```

---

## 目录结构

```
portal/
├── publish/                    预构建 bundle（system portal；run.sh 解压并 serve）
│   └── system.v{{SOLO_VERSION}}.tar.gz
├── operator/                   源码（Vite + React，直接在本项目里定制）
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── system/                     占位（system portal 走 bundle，无源码）
└── README.md
```
