# 反馈：九个 core 服务都接了 `bindAddr()`，唯独 Router 自己漏了 —— 而它是唯一入口

> 来源：finance 派生项目，2026-09-04 做生产安全自查（服务器有公网 IP）时踩到。
> 依据：**全部实测**。① 现象在 N100 的 finance dev 实例上实测（装的是 bundle
> `solo.v1.2.11.js`）；② 根因在 **solo 当前源码树 v1.2.13** 上逐个 `grep` 核对，
> 不是从 bundle 产物反推的；③ 文中 `bindAddr` 的语义引自
> `api/library/ports.js` 的原注释，未改述。
> 涉及：`api/router/index.js:440`（唯一漏网处），对照组是同一棵树里的
> `api/core/{administrator,user,agent,nexus,gateway,notification,ingress,mcp,orchestrator}/index.js`。
> 影响面：**所有把 Router 部署在有公网 NIC 的机器上、又用反向代理挡在前面的派生项目**。
>
> 一句话：`bindAddr()` 这套 opt-in 加固已经铺到了九个 core 服务，
> 但**没有铺到最该锁的那一个** —— Router 是全栈唯一入口，持有完整方法路由与鉴权面。

---

## 一、实测现象

finance 的 dev 实例（N100，Debian）在 `.env` 里设了一行：

```sh
BIND_ADDR=127.0.0.1
```

重启后 `ss -lntp` 的结果 —— 除 Router 外全部收敛到 loopback：

```
*:8620                     ← Router，岿然不动
127.0.0.1:8621 … :8632     ← 九个 core 服务，全部收敛
127.0.0.1:8633/8634/8635   ← 项目自己的三个私有服务（项目侧改代码接上 bindAddr 后）
127.0.0.1:8636             ← local-oss
```

也就是说：**项目按文档设了全局开关，九成服务照做，唯一对外的那个没照做**，
而且没有任何日志或告警提示"Router 不受此开关管辖"。

## 二、根因

`api/router/index.js:440`：

```js
        app.listen(PORT, () => {
          logger.info(`Solo·AI Router active on port ${PORT}`);
        });
```

同一棵源码树里的九个 core 服务全都是另一种写法，例如
`api/core/user/index.js:85`：

```js
        app.listen(PORT, bindAddr('user'), () => {
```

（另八处：`administrator/index.js:55`、`agent/index.js:169`、`nexus/index.js:71`、
`gateway/index.js:71`、`notification/index.js:73`、`ingress/index.js:54`、
`mcp/index.js:56`、`orchestrator/index.js:133`。）

漏的正是入口进程。就防护价值而言，这九个加起来也不如 Router 一个：
core 服务多半只被 Router 调用，而 Router 持有全部方法路由、鉴权与 session 发放。

## 三、为什么这不该用「Router 本来就要对外」搪塞过去

Router 确实常常需要对外，这是它和其他 core 服务的真实差别。但这**不构成不接
`bindAddr` 的理由**，有三点：

1. **`bindAddr()` 是 opt-in，不改默认行为。** `api/library/ports.js` 的注释已把这点
   写成 load-bearing 的设计约定：返回 `undefined` 时 `listen(port, undefined, cb)`
   与 `listen(port, cb)` 逐字节等价，"a project that sets neither variable keeps
   today's all-interfaces behavior byte for byte"。所以接上去**不会破坏任何现有部署**。
2. **反代场景下 Router 根本不需要对外。** finance 生产的 nginx 就是
   `proxy_pass http://127.0.0.1:8426/`，Router 绑全网卡纯属多余暴露面；
   目前唯一的屏障是机器级防火墙（ufw 只放行 22/80/443），
   而那正是 `ports.js` 注释里点名要避免的状态 ——
   "the only way to stop it is a machine-level firewall.
   'Which service is exposed' is a deployment decision that belongs in the project,
   not in some host's nftables."
3. **per-service 覆盖本就是为这种情况设计的。** 需要 Router 对外的部署写
   `BIND_ADDR=127.0.0.1` + `ROUTER_BIND_ADDR=0.0.0.0`，语义正好是
   "锁住全部、只开入口" —— 这恰恰是 `ports.js` 注释举的那个例子的形状
   （`BIND_ADDR=127.0.0.1  CODER_BIND_ADDR=0.0.0.0`）。
   现在 Router 不参与这套机制，这个表达就说不出口。

## 四、建议（按价值排序）

1. **`api/router/index.js:440` 接上 `bindAddr('router')`**，与九个 core 服务一致。
   一行改动，opt-in，零破坏性。
2. 加一条防复发的检查：autocheck 已有 `[bind-addr]` 规则（finance 侧实测它能正确
   识别"listen 已接 bindAddr()"并从 ⚠️ 转 ✅），但它只扫 `api/apps/`，
   扫不到 `api/router/` 与 `api/core/`。把扫描面扩到 core 与 router，
   这类"铺开一半"的疏漏就不会再出现第二次。
3. scaffold 的 `.env.example` 里给 `BIND_ADDR` 一行注释，说明它管哪些进程 ——
   现在项目侧无从得知"设了它到底会作用到谁"，只能设完再 `ss -lntp` 数一遍。

## 五、处理结论（2026-09-05 核实，**结论=采纳，三条全部落地**）

**报告属实，核心事实逐条复核过**：`api/router/index.js:440` 确是全仓唯一没接 `bindAddr()` 的
`app.listen`（9 个 core + 6 个 apps 全接上了）；`ports.js` 的 opt-in 论证也成立。

### 一处事实校正：autocheck 的扫描面

本篇 §四.2 说规则「只扫 `api/apps/`，扫不到 `api/core/` 与 `api/router/`」——**`core/` 是错的**。
CI 的 per-service 循环（`.github/workflows/ci.yml`）本就覆盖 6 个 apps + **8 个 core** + sample，
**那正是九个 core 全都接上 `bindAddr` 的原因**。真实缺口是两个具体目录：

- `api/router`——**不是"忘了加进循环"，是加不进去**：实跑 `checker.js router --static` 报
  **12 个 ERROR**，全部来自形状（没有 `serviceName`、没有 `/auth/seed|verify` 路由、
  系统方法未白名单、`package.json` 有 dependencies…）。所以建议 2 不是"把扫描面扩到 core 与
  router"一句话，得先有个跑规则子集的口子。
- `core/mcp`——**同类疏漏，本篇没发现**：它一直不在 CI 那 15 个目录里，它的 `bindAddr`
  是手工加的、不是被门禁逼出来的。

顺带确认：bind-address 规则本身指向 router 时**工作正常**，准确报出了 `index.js:440`。

### 落地（v1.2.13，见 CHANGELOG）

1. **建议 1 ✅** `api/router/index.js` 接 `bindAddr('router')`。
2. **建议 2 ✅，但做成了通用口子**：autocheck 新增 `--rules=<a,b>`（对任意路径只跑点名规则，
   跳过服务形状校验）与 `--strict`（WARN 也阻断）。CI 新增一步
   `checker.js router --rules=bind-address --strict`；`core/mcp` 补进 per-service 循环（15→16）。
   **`--strict` 是必需的**：bind-address 对存量服务刻意是 WARN 级，光把 router 加进 CI 而不
   `--strict`，回退时照样绿——那等于只多打了一行字。已模拟回退实测：门确实红。
3. **建议 3 ✅** `deploy/scaffold/.env.example` 补 `BIND_ADDR` 段。本篇说「项目侧无从得知」略重——
   `run.sh:407`、`init.sh:423`、`docs/authoring/service.md:75`、`SKILL.md:140` 四处都讲了；
   但**消费者最先打开的那个文件**确实一个字没提，补的是这一格。至于「Router 不受此开关管辖」
   那句，建议 1 落地后不需要存在了。

### 发版前实测了本篇没覆盖的那一面：升级会不会踩到人

本篇把改动称作零破坏，**这对「没设 `BIND_ADDR` 的部署」成立，对「已经设了的」不成立**——
后者的 Router 会从绑全网卡收敛到 loopback，跨主机反代会当场断。所以逐台核过：

- **N100**：`~/AI/*/` 八个栈里**只有 finance dev 设了** `BIND_ADDR=127.0.0.1`，其 Router 现在
  确实是 `*:8620`（本篇现象原地复现）。但 **8620 从任何地方都够不着**——VPS Caddy 没有指向
  `100.64.251.83:8620` 的回源，N100 的 nftables 是 `policy drop` 且放行清单里没有 8620。
  其余**跨机可达**的 Router（runner 8600 / colony 8465 / trend 8500 / steward 8520 / overview 8400
  / solo 8540，全部经 Caddy → tailnet 回源）**一个都没设 `BIND_ADDR`** ⇒ 逐字节等价。
- **finance 生产（64.176.61.210）**：三个栈（finance / finance-tianmei / finance-dev）
  **都没设**，且 nginx 全部 `proxy_pass http://127.0.0.1:<port>`（同机 loopback）⇒ 零影响。

⇒ 已知部署全部不受影响。CHANGELOG 仍按 ACTION REQUIRED 写明这一条，因为**判据是"设没设
`BIND_ADDR`"**，别的消费者可能设了。
