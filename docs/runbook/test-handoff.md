# TEST-HANDOFF · 跨机器测试协作单

> 给另一台机器(或另一个 Claude 会话)直接读取执行的测试清单。
> 原则:**先读"已验证"避免重复劳动,再跑"待你跑",踩坑先查"已知坑"。**
> 更新时间:2026-06-12。执行完请回写结果(✅/❌ + 一行说明)。

---

## 0. 环境前置(两种栈,选一)

```bash
# A. dev 栈(带种子:bots/workflows/fulfillment 样例/两只哨兵,redis 无持久化,重启即重置)
bash deploy/dev.sh          # redis:6699 + 13 服务 + portals(:9200/:9300) + mobile(:9500)

# B. 测试栈(e2e harness,自动探测复用已起的端口)
# e2e/jest 的 globalSetup 自动拉起;无需手动。
```

**鉴权逃生口**(dev 栈 admin 密码非 changeme,UI 测试登录用它绕过):
```bash
export SOLO_E2E_TOKEN=solo-dev-admin   # seed-bots 注入的 allow_all 会话,global-setup 识别后直写 state
```

---

## 1. 已验证 ✅(本机 2026-06-12,无需重复;回归时按需重跑)

| 套件 | 命令 | 结果 |
|---|---|---|
| mobile 路由桩 e2e(focus 读路径 + STM/LTM/correction 记忆) | `cd e2e/ui && npx playwright test --config=playwright.mobile.config.ts` | **4/4** ✅(需 :9500 已起;config 自带 webServer 会复用) |
| 哨兵供给全旅程(横幅 CREATE→INJECT→TOKEN 列→/nexus 徽章→PERMIT 对照表) | `cd e2e/ui && SOLO_E2E_TOKEN=solo-dev-admin npx playwright test --project=system tests/system/sentinel-provisioning.spec.ts` | **2/2** ✅ |
| EVENT BUS(默认 RUNS、FAILED/STALLED 筛选、STREAM LOG 真流量) | `…tests/system/event-bus.spec.ts` | **2/2** ✅ |
| operator profile 盯守区(pin 语义:只挂被锁定的卡) | `cd e2e/ui && SOLO_E2E_TOKEN=solo-dev-admin npx playwright test --project=operator tests/operator/profile-watchers.spec.ts` | **1/1** ✅ |
| §1.2 身份链 live suite(预审拒绝 + 自有 token fetch + **token 缺失中止不回退→注入后恢复**) | `cd e2e && E2E_PROFILE=full npx jest suites/67-nexus-sentinel-identity --runInBand` | **3/3** ✅(9.9s,对活栈跑;**注意坑 #1**) |
| CI hermetic 绿集(api) | `cd api && redis-stack-server --port 6379 --daemonize yes --save "" && npx jest -c jest.ci.config.js --ci --runInBand` | 此前全绿(65+ 套;新增 nexus events 4 + sentinel identity 3 + focus 4)。**必须 redis-stack-server**——CI 子集含 RedisJSON/stream 套(orchestrator/storage/nexus/walarchiver),普通 redis-server 会挂死(CLAUDE.md §6) |

---

## 2. 待另一台跑 🔲(需要本机没有的条件)→ **已全部执行 ✅(主机 2026-06-12,rebase 后代码 8466e82)**

### 2.1 live-qwen focus 冒烟(需 `DASHSCOPE_API_KEY`)✅
```bash
# key 配在 api/core/agent/.env(勿提交)。无 key 时该段自动 skip——跑了等于没跑,先确认 key 在。
cd api && npx jest -c jest.ci.config.js core/agent/tests/focus.test.js --runInBand
# 预期:hermetic 3 过 + LIVE qwen 段 1 过(真打 qwen-turbo json-mode 抽参)
```
同理可跑 decide 的 live 段:`core/agent/tests/decide.test.js`(qwen + gemini 各自按 key 门控)。

> **结果**:focus **4/4**(0 skip = LIVE qwen 段真跑);decide **12/12**(qwen + gemini live 段都跑了,key 双在)。

### 2.2 全量 live e2e(55+ 套,验证 13 服务网格无回归)✅
```bash
cd api && npm ci && cd ../e2e && npm ci
E2E_PROFILE=full REDIS_URL=redis://localhost:6699 npx jest --runInBand
# 需 redis-stack(RedisJSON)。CI 的 e2e job 跑的就是这个;本地全量跑约 10-20 分钟。
```

> **结果**:**55/55 套,275 过/6 跳/0 挂**(~7 分钟)。注意:本机 dev 栈占着标准端口,
> 直接按上面命令跑会把 dev 服务当 external 复用(真 LLM + 持久旧状态,结果不可信)——
> 实际用的是隔离档:`E2E_PROFILE=full E2E_PORT_OFFSET=2000 REDIS_URL=redis://localhost:6701 npx jest --runInBand`
> (harness 已支持,见坑 #7)。

### 2.3 风险哨兵人工剧本(UI 端到端,无自动化覆盖的部分)✅(RPC 层全链;UI 视觉未人眼复核)
1. BOT ACCOUNTS:横幅应列 `Deposit Risk Review` 待供给 → INJECT
2. operator → SO-DEMO-002 详情:meta 补 `amount_received: 3750` → 转移 `deposit_received`
3. 验证:STREAM LOG 出现 `EVENT:SENTINEL:RISK-REVIEW`(有 qwen key = 真决策;无 key = `decision:defer, escalate:true`,降级可见即正确)
4. 故障注入(可选):PERMIT 删 `agent.decide` → 投递带 `autorun_error`;不注 token → DLQ

> **结果**(dev 栈已重启到新代码后,经 RPC 执行 1→3):
> ① sentinel `zWil40UJnOBW` 初始 `hasToken:false`(= 横幅待供给态)→ `user.bot.issue.token` + `nexus.sentinel.token.set` 注入 → `hasToken:true`;
> ② `FL-20260612-1022`(SO-DEMO-002)meta 补 3750 → `fulfillment.instance.transition deposit_received` → DEPOSIT_CONFIRMED;
> ③ ~3.4s 后 `EVENT:SENTINEL:RISK-REVIEW` 落一条 `sentinel.risk.assessed`:**真 qwen 决策** `{decision:approve, confidence:1, escalate:false}`,
>    信封带全链 trace(trace_id/parent_event_id/depth:2/确定性 event_id `snt-{id}-{ref}`);`nexus.event.recent`(STREAM LOG 读端点)同步可见。
> ④ 可选故障注入未做(token 缺失→DLQ 语义已由 suite 67 自动化覆盖);横幅/徽章的**视觉**呈现未人眼复核(语义态已验)。
> ⚠️ 途中发现:dev.sh 的 inject-fulfillment 哨兵段仍有 seed race 残留(nexus 注册完成前调 `nexus.sentinel.create` → not found,
>    fail-soft 只写日志)——手动重跑 `node deploy/mock/inject-fulfillment.js` 即补齐(幂等)。见坑 #8。

---

## 3. 已知坑 ⚠️(先读,省两小时)

1. **对活 dev 栈跑 e2e suites 后,teardown 会删 `SYSTEM:CONFIG:EVENT_REGISTRY`**(Router 退回 config 默认表;fulfillment/sentinel 不受影响,但 mock 支付链 fixture 放行没了)。恢复:`node deploy/mock/inject-workflows.js --active`。
2. **Playwright strict mode**:`getByText(/A|B/)` 命中多个元素直接挂——用单一文案或 `data-test`。
3. **`page.locator('select').first()` 会抓到布局里的语言下拉**——状态筛选器要 `filter({ hasText: 'ALL STATUSES' })` 锚定。
4. **mobile 的 Playwright 配置是独立的**(`playwright.mobile.config.ts`,无 globalSetup、自带 vite webServer、会复用已起的 :9500);别用主 config 跑 mobile。
5. dev 栈 redis `--save ""`:**停栈=数据清零**,所有种子幂等重注,别把状态当持久。
6. 本仓 npm-only:**别跑 yarn**;装不上 npm 时本机 `~/.npmrc` 配镜像 + 只用 `npm ci`(CI 卫生闸会拦镜像 URL 进 lock)。
7. **dev 栈在跑时,e2e 必须用端口偏移隔离**:`E2E_PORT_OFFSET=2000 REDIS_URL=redis://localhost:6701`。
   否则 harness 把端口被占的 dev 服务当 external 复用(真 LLM/无 loopback 放行/持久旧状态),失败集合随机漂移。
   另:redis-stack-server 不带 `--dir` 会加载共享目录的陈年 dump(几百 MB,超探针时限→静默退化成无 RedisJSON 的普通 redis)——harness 已改为 per-run `--dir`,别绕过它手起。
8. ~~**dev.sh 的哨兵种子有竞态残留**~~ **已修(2768702 后)**:`inject-fulfillment.js` 现在用泛化的
   `waitForMethod` 在哨兵段前显式探 `nexus.sentinel.list` + `user.bot.list` 就绪,不再死在 not-found。
   (注:若手动跑撞 `Authorization Required`,是 dev 的 `solo-dev-admin` 会话过期 ≠ 此 bug——`node deploy/seed-bots.js` 重注会话即可。)

---

## 4. 测试地图(现有的网,改哪层跑哪层)

| 层 | 套件 | 阻塞 CI? |
|---|---|---|
| api 静态 | `autocheck --static` ×15 目录 + doc-drift + lockfile 卫生 | ✅ |
| api hermetic | `jest.ci.config.js` 白名单(含 agent focus/decide、nexus events/sentinel/identity) | ✅ |
| api live e2e | `e2e/suites/` 55+ 套(整栈黑盒;67=§1.2 身份链) | ✅ |
| portal 类型 | `tsc --noEmit` ×2 portal | ✅ |
| UI e2e(system) | `e2e/ui` Playwright(smoke/login/approval/bot/nexus/ingress/**sentinel-provisioning/event-bus**) | ⚠️ 非阻塞 |
| UI e2e(operator/mobile) | profile-watchers / fulfillment-profile;mobile 4 spec | ❌ 未进 CI(本地跑) |

## 5. 遗留缺口(下一批,按价值排序)

- [ ] 前端镜像函数 parity:`permitAllows`(NexusManagement)/`extractProfilePin`(ProfileList)无单测,后端语义变更会静默漂移(portal 无 vitest 基建;短期靠 e2e 钉)
- [ ] approval 渲染完整性:审批模态内容 ↔ `workflow.get` 字段级一致(盲签禁令的最后一块)
- [ ] ui-e2e CI 只跑 `--project=system`:operator/mobile 进 CI + 整体转阻塞(低 flake 验证后)
- [ ] FAILED run 的**确定性**制造(event-bus spec 目前机会性断言失败原因行)
