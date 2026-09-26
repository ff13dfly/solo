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

（待 triage）
