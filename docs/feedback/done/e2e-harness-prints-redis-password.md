# e2e harness 启动时把带密码的 `REDIS_URL` 原样打印到输出里

- **来源**：steward，2026-09-26，给 hive 补「多账号并发派单不卡死」的 e2e 套件（`e2e/suites/10-hive-concurrency.e2e.test.js`），
  在本机隔离栈上跑 `npm test` 时发现。
- **场景**：任何派生项目在本机或 CI 里跑 `e2e/`（`npm test`），且 `.env` 按 v1.1.14+ 的做法给 Redis 设了密码。
- **依据分类**：**实测**。steward 跑 e2e 时第一行输出就是 `[E2E] setup — redis=redis://:<48 位 hex>@127.0.0.1:6385 …`，
  那串密码当场进了终端和会话记录。模板里同一行已在 solo 仓核对过（见下）。
- **涉及**：`deploy/scaffold/e2e/harness/setup.js`（脚手架模板；派生项目的 `e2e/` 归项目所有，升级不覆盖）。

## 实测现象

`globalSetup` 的第一条日志：

```js
console.log(`\n[E2E] setup — redis=${REDIS_URL}  router=${ROUTER_URL}`);
```

`REDIS_URL` 取自项目 `.env`，形如 `redis://:<REDIS_PASSWORD>@127.0.0.1:<port>`（v1.1.14 起 run.sh 就是这么要求的）。
于是**每跑一次 e2e，密码就落进一处新的地方**：终端回滚、CI 日志、AI 会话记录。

为什么比「只是本机 dev 密码」严重：至少 steward 的 `.env` 是由 `prod.sh` **整份同步**到线上 N100 的，
本机那份 `REDIS_PASSWORD` 就是线上 Redis 的密码。全局规矩里「别用 `redis-cli -a`，那会把密码泄进 `ps`」
防的是同一类泄露，这里是另一个出口。

## 根因

模板在日志里拼接的是完整连接串，没有剥掉 userinfo 段。`run.sh` 那边早就刻意避开了同类问题
（`export REDISCLI_AUTH`、不用 `-a`），e2e 模板没跟上。

## 建议（按价值排序）

1. **模板里打码**（一行）：`REDIS_URL.replace(/\/\/([^@/]*)@/, '//***@')`。steward 已在自己的 `e2e/harness/setup.js`
   这么改了，本地验证过带密码与不带密码两种形态（不带密码时原样输出）。
2. 升级说明里点一句：`e2e/` 归项目所有、升级不覆盖，**存量项目要各自补这一行**，否则模板修了也传不过去。
3. （可选）同一个 harness 里 `loadEnvFile()` 的正则 `/^([A-Z_][A-Z0-9_]*)=(.*)$/` 不剥引号——`.env` 统一单引号之后，
   `REDIS_URL='…'` 会连引号一起被当成 URL。steward 的 `REDIS_URL` 恰好没加引号所以没踩到；按全局「`.env` 值统一单引号」
   的规矩走的项目会踩。

## 处理结论

**2026-09-26 · 建议 1、2 采纳并落地；建议 3 早已修复（v1.2.2）；顺带堵上同一类的另外两个出口。已归档。**

### 核实

- 模板 `deploy/scaffold/e2e/harness/setup.js:101` 原样打印 `REDIS_URL`：**属实**。
- solo 自己的 `e2e/harness/setup.js` 有同样的问题（`:139` Redis 已在跑时的提示、`:168` 连不上时的报错）。
- **建议 3（`loadEnvFile` 不剥引号）模板里早就修了**：`57aa2cd`（2026-08-20，首发于 v1.2.2）把手写正则换成了
  `library/env.js` 的共享解析器，输出与 dotenv 逐字节一致。steward 踩到是因为 `e2e/` 归项目所有、升级不覆盖，
  它那份 harness 是更早 init 时拷过去的旧副本——**与本篇建议 2 是同一个传播问题**。

### 落地

- **`library/env.js` 新增 `redactUrl()`**：把 `//` 与主机之间的凭据段整段换成 `***`（密码里带未转义的 `@` 也盖全）；
  没有凭据段或不是字符串时原样返回。`tests/env.test.js` +5 例。
  没照原文把正则直接写进 harness：打印 URL 的地方不止这一处（见下），**没有共同原语的话，下一处还会漏**。
- 两个 harness 的打印点改用它（模板 1 处、solo 自己 2 处）。
- **同一类出口，核实时顺带扫出来的**（`grep -rnE "console\.(log|…)\(.*REDIS_URL"`）：
  - `apps/fulfillment/migrate/export-profiles.js` **把原样的 `REDIS_URL` 写进了导出文件的 `meta.source`**——
    这比打印更糟，导出文件本来就是要拷走、归档的东西。已改为打码后的值（`import-profiles.js` 不读这个字段）。
  - `export/import-profiles.js`、`seeds/seed-demo.js`、`orchestrator/scripts/seed_bot.js` 的启动打印。
  - 没动：`nexus/tests/pipeline.integration.js`、`library/tests/wal-recovery.test.js`、`autocheck/simulation/framework/redis.js`
    ——都只连测试库。
- **e2e 上下文文件改为 0600**（`e2e/lib/context.js`，模板与 solo 各一份）：harness 把**真实的** `redisUrl`
  和 `adminToken` 写进 `os.tmpdir()/solo-e2e-context.json` 供各套件读取（这一处不能打码，套件要拿它连库）。
  macOS 的 tmpdir 是按用户隔离的，但 Linux 上是全机共享的 `/tmp`，默认 0644 ⇒ **同机任何账号都读得到**。
  N100 已经有第二个登录账号（finance 协作者），这一条不是理论上的问题。
- 建议 2 写进 CHANGELOG 的下游 action：存量项目各自补两处（harness 打印行 + context.js 的 mode）。

没做：给 `doctor.sh` 加一条「项目的 `e2e/harness` 还在原样打印 `REDIS_URL`」的检测。
`e2e/` 归项目所有是有意的设计，靠 CHANGELOG 的 ACTION REQUIRED 横幅通知；真要做，下一次再有模板修复需要传播时一起考虑。
