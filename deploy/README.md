# 本地开发工具

本目录存放仅用于本地开发的脚本，不上传到服务器。

---

## 脚本说明

| 脚本 | 用途 | 执行方式 |
|------|------|----------|
| `dev.sh` | 本地全栈一键启动：装依赖 → 起独立 Redis(6699) → 调 `dashboard_all.sh` | `bash deploy/dev.sh [native] [--ssl]` |
| `dashboard_all.sh` | 后端微服务 + 前端开发服务器统一仪表盘（不自带 Redis） | `bash deploy/dashboard_all.sh [native] [--ssl]` |
| `dashboard_run.sh` | 仅后端微服务仪表盘（best-effort 起 Redis） | `bash deploy/dashboard_run.sh [--ssl]` |
| `dashboard_dev.sh` | 仅前端开发服务器仪表盘 | `bash deploy/dashboard_dev.sh [native]` |
| `build.sh` | 将 `services.json` 列出的微服务打包为单文件 `api/publish/solo.js` | `bash deploy/build.sh` |
| `build-frontend.sh` | 打包前端 bundle（operator/system/mobile）到 `portal/publish/`、`client/publish/` | `bash deploy/build-frontend.sh` |
| `release-bundle.sh` | 从 git tag materialize 各版本不可变 bundle 到 `release/`（gitignored，可复现，供归档到 Release/对象存储） | `bash deploy/release-bundle.sh v1.1.0 v1.1.1 v1.1.2` |
| `mock.sh` | 启动 dev 用的 mock webhook listener，演练 ingress 入站链路 | `INGRESS_API_KEY=ingk_xxx bash deploy/mock.sh` |
| `precheck.sh` | 打包前对 `apps/` 服务跑 autocheck 静态闸门（build.sh 自动调用） | `bash deploy/precheck.sh` |
| `check-doc-drift.js` | CI 守护：`CLAUDE.md §2` 服务清单 ⇄ `services.json` 一致性 | `node deploy/check-doc-drift.js` |

所有脚本均可从**项目根目录**执行，`ROOT_DIR` 由脚本自动推导（`deploy/` 上一级）。

---

## dev.sh

本地全栈一键启动。先按需补装前端/后端依赖，再在 **6699** 端口起一个独立 Redis（优先 `redis-stack-server`，自带 RedisJSON；找不到才退回普通 `redis-server`，此时 orchestrator/storage/nexus 会因缺 `JSON.SET` 失败），最后透传参数调起 `dashboard_all.sh`。Ctrl+C 退出时会一并关掉这个 Redis。

```bash
bash deploy/dev.sh          # 浏览器模式（默认）
bash deploy/dev.sh native   # Solo Desktop 走 Tauri 原生窗口
bash deploy/dev.sh --ssl    # 额外起 local-ssl-proxy（8800 → Router 8600）
```

---

## dashboard_all.sh / dashboard_run.sh / dashboard_dev.sh

仪表盘式启动器（终端内实时刷新各服务状态 + 日志预览），区别在管理范围：

- `dashboard_all.sh`：后端 + 前端全栈。后端服务读 `services.json`（外加可选的 dev-only `services.dev.json` overlay）。**不自带 Redis**——直接跑它时需先有 Redis（推荐用 `dev.sh` 由它托管 6699 上的 Redis）。
- `dashboard_run.sh`：仅后端微服务；若检测不到 Redis 会 best-effort 起一个。
- `dashboard_dev.sh`：仅前端开发服务器。

前端服务（端口取自 `dashboard_all.sh` / `dashboard_dev.sh`）：

| 前端 | 地址 |
|------|------|
| Portal System | http://localhost:9200 |
| Portal Operator | http://localhost:9300 |
| Solo Mobile | http://localhost:9500 |
| Solo Desktop | http://localhost:9600 |

`native` 模式下 Solo Desktop 改用 `npx tauri dev`；`--ssl`（仅 `dashboard_all.sh` / `dashboard_run.sh`）会起 `local-ssl-proxy`（8800 → Router 8600，需本地证书 `~/.certs/`）。

---

## build.sh

由 `gen-entry.js` 依据 `services.json` 生成临时入口 `api/_entry.js`（懒加载工厂注册表 + 运行时按 `SOLO_SERVICES_JSON` 取舍服务/端口），用 esbuild 打包为 `api/publish/solo.js`，构建后删除临时入口。打包前会调 `precheck.sh` 跑静态闸门，失败即中止；worker 等无法内联的 side-file 会单独拷到 `api/publish/`。

`build-frontend.sh` 则把 `portal/operator`、`portal/system`、`client/mobile` 各自 vite build 后打成 `*.v{version}.tar.gz`，输出到 `portal/publish/` 与 `client/publish/`。

---

## mock.sh

启动 dev-only 的 mock webhook listener（`deploy/mock/listener.js`），向它 POST 任意 JSON，它会包成 `{ request_id, data }` 带 API key 转发到 ingress `/ingest`，演练完整入站链路：`curl → mock listener → ingress → EVENT:WEBHOOK:* → matcher/agent`。需先在 Portal → Ingress（或 `ingress.source.create`）建一个 source 并拿到一次性 API key。默认走 HTTPS 前端（`https://127.0.0.1:8800`，需 `--ssl` 代理）。

---

## services.json / services.dev.json

`services.json` 是本地运行/打包的服务注册表，被 `build.sh`、`dashboard_*.sh`、`precheck.sh`、`check-doc-drift.js` 共同读取（运行权威）。`services.dev.json` 是仅在 dev 仪表盘里追加启动、**不进打包**的 overlay（business 测试夹具 collection/market，使框架 bundle 保持无业务）。服务器端各有独立的注册表副本，与本地独立维护。
