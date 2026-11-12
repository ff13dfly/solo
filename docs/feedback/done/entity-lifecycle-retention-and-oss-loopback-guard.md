# 立项：高周转 RPA / 流水实体的生命周期留存归档（Entity `retention`）与生产环境 `LOCAL_OSS_OUTWARD_ORIGIN` 回环死链门禁

> 来源：2026-11-07 四栈（`Catalog` / `Steward` / `Finance` / `Solar`）履约与 RPA 真实运行数据盘点立项。
>
> **依据分三类**：
> - **线上实测数据（2026-11-07）**：
>   1. `BC001` (`Steward` Redis `:6385`) 中高频周转实体全量常驻内存且单调增长：`HIVE:JOB:*` **2,005 条**（其中终态 `DONE: 1,701` + `EXPIRED: 221` + `ERROR: 52` 占 **98.4%**）、`SCOUT:*` 采集快照 **1,861 条**；每次无二级索引的 `list()` 均需 `mGet` 扫描全部历史终态键；
>   2. `BC002` (`Finance` Redis `:6379`) 已完成履约记录的附件 URL 中出现真实生产脏数据：`http://127.0.0.1:8124/assets/...`——起因是生产部署时漏配 `LOCAL_OSS_OUTWARD_ORIGIN`，`apps/storage` 默认回退到本机端口拼出外发 URL，跨机节点（`Steward` / 浏览器端）打开即死链。
> - **源码核对**：
>   - `api/library/entity.js`（`createEntity` 目前支持 `softDelete: boolean`，尚无按终态 + 账龄自动冷归档并驱逐热 Redis 键的声明式 `retention` 原语）；
>   - `api/apps/storage/config.js` 与 `logic/oss.js`（`localOssOutwardOrigin` 缺省回退本机地址）；
>   - `deploy/doctor.sh`（生产环境配置自检脚本，目前未拦截公网/跨机模式下 `LOCAL_OSS_OUTWARD_ORIGIN` 指向 `127.0.0.1` / `localhost` 或缺失）。
> - **已先行落地的互补防线（2026-11-07）**：`apps/fulfillment` 已在 `transition.evidence.rejectLoopbackUrls` 增加消费侧守卫，拒绝把 `127.0.0.1` / `localhost` URL 写进完成态履约凭证（见 [`rpa-fulfillment-convergence-and-evidence-gate.md`](./rpa-fulfillment-convergence-and-evidence-gate.md)）；本篇立项解决**生产源头配置自检**与**高周转实体热内存膨胀**两个根问题。

---

## 一、高周转实体声明式留存与冷归档（Entity Factory `retention`）

### 1.1 为什么不能靠业务手工 `destroy` 或 `softDelete: true`
- **手工 `destroy` 丢审计对账**：RPA 工单（`hive.job`）、投递台账（`gateway.delivery`）、运行记录（`orchestrator.run`）在排障与周会复盘窗口（如 7～30 天）内仍需按 ID / 状态热查，不能跑完立刻删；但超过 30 天的终态记录继续留在 Redis 主集合里，既占内存又拖慢全量扫描式 `list()`（`BACKLOG.md` §3 实体读写面已指出无二级索引时过滤成本与总历史量成正比）。
- **`softDelete: true` 反增墓碑负担**：`BACKLOG.md` §3 已记录某 churn 实体 87% 键为 `DELETED` 墓碑。

### 1.2 目标契约（`api/library/entity.js`，只加不破）
在 `createEntity(redis, config, options)` 新增可选声明：
```js
retention: {
    ttlDays: 30,                                  // 终态保留天数（以 updatedAt / createdAt 计，走 clock.now()）
    terminalStates: ['DONE', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED'], // 仅终态可归档，活跃态永不误删
    stateField: 'status',                         // 默认 'status'，支持 'state'
    coldArchive: true,                            // 驱逐前按月追加写入冷归档 JSONL(.gz) 并校验落盘成功，确保零数据丢失
}
```
- **执行方式**：提供显式方法 `entity.compact({ dryRun, batchSize })`（管理员或低峰期 `nexus` 定时任务 / `wal-rotate.sh` 同机生命周期触发，**严禁在每次读写热路径里做全表扫描**）；
- **原子性与守恒**：先写冷归档行并 `fsync`，再在单次 `MULTI` 内同时清理主实体键、SET 索引（`INDEX`）与 ZSET 游标索引（避免重蹈游标孤儿键泄漏），返回 `{ scanned, archived, skippedActive, archiveFile }`。

---

## 二、`deploy/doctor.sh` 与 `apps/storage` 生产外发域名回环自检

### 2.1 事故机理
在单机开发模式下，`apps/storage` 本地驱动返回 `http://127.0.0.1:8124/...` 是合理的零配置默认；但在生产环境（`NODE_ENV=production` 或配置了公网/内网 `ROUTER_PUBLIC_URL` / `CORS_ORIGINS` 非 loopback 时），若 `.env` 漏配 `LOCAL_OSS_OUTWARD_ORIGIN`（或误填 `localhost` / `127.0.0.1`），`storage.asset.upload` 依然静默返回 `200 OK` 并把回环 URL 发给业务层，直到数天后跨机节点或外部客户打不开附件才暴露。

### 2.2 目标护栏
1. **`deploy/doctor.sh` 静态 + 运行时预检**：
   - 当部署使用本地存储驱动（`OSS_PROVIDER=local` 或缺省）且非纯本机开发栈时，若 `LOCAL_OSS_OUTWARD_ORIGIN` 未设置或主机名为 `127.0.0.1` / `localhost` / `::1` / `0.0.0.0`，`doctor.sh` 明确输出 `WARN/FAIL` 并给出修复指引（如指向反向代理静态域名 `https://oss.<domain>` 或 Router 资产代理源）。
2. **`apps/storage` 启动期强告警**：
   - `NODE_ENV=production` 下检测到本地驱动外发 origin 指向 loopback 时，启动日志打显著 `logger.warn`，并在 `/health` 附带非阻塞配置提示字段，方便巡检哨兵第一时间捕获。

---

## 处理结论（solo 侧 · 2026-11-12 落地归档）

- ✅ **§一 `Entity retention` 与 `entity.compact()` 已落地**：`api/library/entity.js` 支持声明式 `retention: { ttlDays, terminalStates, stateField, coldArchive }` 与显式 `entity.compact({ dryRun, batchSize, archiveDir })`，先追加写入按月 JSONL 冷归档并 `fsyncSync`，再在单次 `MULTI` 中原子驱逐主数据键、SET 索引与 ZSET 游标索引。
- ✅ **§二 `LOCAL_OSS_OUTWARD_ORIGIN` 生产回环护栏已落地**：`deploy/scaffold/doctor.sh` 与 `api/apps/storage/oss/index.js` 均已补齐生产环境 `OSS_PROVIDER=local` 下 `LOCAL_OSS_OUTWARD_ORIGIN` 缺失或指向 loopback 的显式告警。本篇移入 `docs/feedback/done/`。
