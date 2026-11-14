# `deploy/doctor.sh` 跨箱契约导出、`/_oss/*` 连通探活与 Ollama 保活提示建议

> **提交日期**：2026-11-14  
> **来源项目**：`bence` / `steward` / `finance`（跨系统联调与柔性部署实践）  
> **状态**：已处理并归档（2026-11-14）  
> **关联已归档底座反馈**：[`deploy-doctor-out-of-the-box.md`](./done/deploy-doctor-out-of-the-box.md)、[`entity-lifecycle-retention-and-oss-loopback-guard.md`](./done/entity-lifecycle-retention-and-oss-loopback-guard.md)、[`2026-11-13-storage-asset-id-length-and-163-imap-followup.md`](./done/2026-11-13-storage-asset-id-length-and-163-imap-followup.md)

---

## 一、问题描述与实测背景

SOLO `v1.3.5` 的 `deploy/doctor.sh` 已很好地覆盖了单机内的版本对齐、端口归属、孤儿进程、Redis 归属以及 `LOCAL_OSS_OUTWARD_ORIGIN` 非回环静态检查。但在多箱跨系统协作（如 `Finance ↔ Steward` 跨栈履约、`BC002 → catalog-mini` `SOLO_AGENT_PEER_URL` 模型委托）及面向新环境做「柔性拼装部署」时，实操暴露出 **3 处底座体检盲区**：

1. **缺少脱敏结构化输出（`--json`），跨箱对齐只能人肉 `grep .env`**
   - 近期 `Finance (BC002)` 与 `Steward (BC001)` 联调时，曾因 `BC002` 未显式配置 `ASSET_ID_LENGTH=16`、且未对齐 `STORAGE_ACCESS='private'` + `LOCAL_OSS_OUTWARD_ORIGIN='https://finance.w3os.net/_oss'` + Caddy `handle_path /_oss/*`，导致资产签名 URL 与跨栈校验失败；
   - 目前 `doctor.sh` 仅打印终端着色文本，**无法输出标准化脱敏清单 JSON**，导致外部部署编排或 AI 实施助手无法一键自动比对两个箱子的契约是否一致。

2. **`STORAGE_ACCESS=private` 与外发 `/_oss/*` 网关路径缺少真实可达性校验**
   - `doctor.sh` 目前只做正则判断 `LOCAL_OSS_OUTWARD_ORIGIN` 非 `127.0.0.1` / `localhost`，但即使填成了 `https://finance.w3os.net/_oss`，若反代配置漏加 `handle_path /_oss/*` 或签名通路不通，`doctor.sh` 仍显示绿灯，直到运行期跨栈 `presign` / `PUT` / `resolve` 才暴雷。

3. **本地 Ollama 冷加载超 90s 无预警，缺少保活与 `SOLO_AGENT_PEER_URL` 检查**
   - `2026-11-14` 跨栈严格联调实测中，`BC002` 通过 `SOLO_AGENT_PEER_URL=https://catalog-api.w3os.net/jsonrpc` 委托 `catalog-mini` 本地 `qwen3.5:9b`（16GB MLX）执行 `agent.decide`：由于 `catalog-mini` 未设置 `OLLAMA_KEEP_ALIVE=-1`，模型空闲卸载后首次请求的「冷加载 + 推理」耗时超出 `90s` 上限，触发 `[-32099] Upstream Service Error (agent): timeout of 90000ms exceeded`（模型在显存热态时仅需 `~38s`）。
   - `doctor.sh` 目前完全不检查 `OLLAMA_KEEP_ALIVE`、`OLLAMA_TIMEOUT_MS` 或 `SOLO_AGENT_PEER_URL` 连通性。

---

## 二、建议能力（均收口在底座 `deploy/doctor.sh`，不引入业务耦合）

1. **新增 `bash deploy/doctor.sh --json`（只读、严格零密钥脱敏清单）**
   - 在保持原有默认人类可读输出不变的前提下，支持 `--json` 参数输出当前箱子的标准化状态与契约摘要 JSON，建议包含：
     - `soloVersion`（`.solo-version` 与运行中进程版本是否一致）
     - `assetIdLength`（显式读取 `ASSET_ID_LENGTH` 及是否采用默认值）
     - `storage`: `{ provider, access, localPublicRead, outwardOrigin }`
     - `agent`: `{ provider, ollamaBaseUrl, ollamaModel, ollamaKeepAlive, peerAgentUrl }`
     - `services`: 声明的业务服务及健康状态
   - **红线**：严禁输出任何密码、私钥、Cookie、API Key 或敏感凭据值。

2. **增强存储外发网关与 `ASSET_ID_LENGTH` 提示**
   - 当 `OSS_PROVIDER=local` 且 `STORAGE_ACCESS=private`（或生产域名模式）并配置了 `LOCAL_OSS_OUTWARD_ORIGIN` 时，由 `doctor.sh` 对该外发地址做一次轻量只读探测（确认非 `502`/`503`/TLS 断链或反代前缀错误，例如无有效签名请求应返回存储服务自身的 401/403/400/404 JSON，而非 Caddy 静态页或连接超时）；
   - 显式报出 `ASSET_ID_LENGTH` 当前生效值，提醒跨箱部署人员核对两端一致。

3. **新增 `core/agent` 本地推理保活与 `SOLO_AGENT_PEER_URL` 巡检项**
   - 当实例启用 `ollama`（或配置 `OLLAMA_BASE_URL` / `SOLO_AGENT_PEER_URL`）：
     - 若配置了 `SOLO_AGENT_PEER_URL`，执行一次轻量连通探测（如 `/health` 或允许的 `system.ping`）；
     - 若本机运行 `ollama serve` 且未设置 `OLLAMA_KEEP_ALIVE`（或值较短如默认 `5m`/`30m`），给出黄色 `⚠` 提示建议生产节点设为 `OLLAMA_KEEP_ALIVE=-1`（或延长超时），避免大参数量模型反复冷加载撞破 `90s` RPC 超时线。

---

## 三、验收标准（预期落地形态）

1. 任意基于 SOLO `v1.3.x` 的项目升级 `.solo-version` 后，无需改动业务代码即自带新版 `deploy/doctor.sh`；
2. 执行 `bash deploy/doctor.sh --json` 可直接由上层跨箱总装脚本或 AI 实施助手消费并比对两端 `ASSET_ID_LENGTH`、`outwardOrigin` 与版本基线；
3. 漏配 `/_oss/*` 反代或未设 `OLLAMA_KEEP_ALIVE=-1` 的生产节点能在交付自检阶段提前被 `doctor.sh` 标出 `⚠`/`✗`，不再等到跨栈压测时才暴露 `-32099`。

---

## 四、处理结论（2026-11-14）

已在 [`deploy/scaffold/doctor.sh`](../../deploy/scaffold/doctor.sh) 完成落地并补充单元测试 [`api/tests/unit/doctor-manifest.test.js`](../../api/tests/unit/doctor-manifest.test.js)：
1. 新增 `bash deploy/doctor.sh --json` 参数：输出严格脱敏的结构化 JSON 清单（`soloVersion`、`assetIdLength`、`storage`、`agent`、`services`、`summary`、`checks`），自动剥离 URL userinfo 且不输出任何密钥/Token/密码。
2. 修复 `doctor.sh` 原先读取 `OSS_PROVIDER` 的命名偏差（改为 `${STORAGE_PROVIDER:-${OSS_PROVIDER:-local}}`），显式输出 `ASSET_ID_LENGTH` 生效值与配置来源；当 `STORAGE_PROVIDER=local` 且栈运行且配置了非回环 `LOCAL_OSS_OUTWARD_ORIGIN` 时，自动对 `<outwardOrigin>/` 与 `<outwardOrigin>/<bucket>/__doctor_probe__` 做只读 HTTP 探测，精准识别 `NoSuchBucket`（反代未剥离 `/_oss` 前缀）与 `502`/HTML 错误页。
3. 新增 `core/agent` 巡检：检测到启用 `ollama` 或本机运行 `ollama` 时检查 `OLLAMA_KEEP_ALIVE=-1`（未设置或非 `-1` 输出 `⚠` 提示）及 `/api/tags` 探活；配置 `SOLO_AGENT_PEER_URL` 时执行轻量 `system.ping` 连通性探测。
