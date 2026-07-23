# SOLO 系统引导（第一跳）

> 你是一个外部调用方（人或 AI 代理），这是你需要读的第一份也是唯一一份入口文档。
> 本文由 `system.guide`（匿名可调）原样下发，与 Router 代码同目录、同一次 commit 更新，
> 不存在外挂文档过时问题。读完本文你将知道：怎么说话（信封）、怎么登录（两条链路 +
> 参考代码）、错误码含义、以及下一步去哪拿各服务的任务配方。

## 1. 唯一入口与信封

所有请求都发往 Router 的 JSON-RPC 端点（唯一入口，服务不直接对外）：

```
POST http://<router-host>:<router-port>/jsonrpc
Content-Type: application/json
Authorization: Bearer <token>        # 登录后所有请求都带上；登录类方法可匿名

{ "jsonrpc": "2.0", "method": "<service>.<entity>.<action>", "params": { ... }, "id": 1 }
```

响应二选一：`{ "jsonrpc": "2.0", "result": ..., "id": 1 }` 或
`{ "jsonrpc": "2.0", "error": { "code": <负数>, "message": "..." }, "id": 1 }`。

方法命名恒为 `{service}.{entity}.{action}` 三段式（如 `storage.asset.upload`）；
自省类系统方法除外（`system.*`、`ping`）。

## 2. 认证（先做这件事）

系统是**挑战-响应**登录，不传明文密码。有两条算法**不同**的链路，别混用：

### 2a. 管理员（administrator 服务，单管理员模型）

1. `admin.login.request { username }` → 返回 `{ challenge, salt, iterations }`（challenge 一次性，60 秒过期）
2. 客户端派生：`loginHash = pbkdf2(password + username, hexDecode(salt), iterations, 32, sha256)`（hex 输出）
3. `admin.login.verify { username, challenge, response: sha256(challenge + loginHash) }` → `{ success, token }`

### 2b. 普通用户（user 服务）

⚠️ **注册时必须客户端自带 `salt` + `hash`**——不传则服务端随机生成一个你不知道的，
该账号**永远无法登录**。这是最常踩的坑。

1. `user.register { name, salt, hash }`，其中 `salt` 自生成（16 字节 hex）、`hash = sha256(password + salt)`
2. `user.login.request { name }` → `{ challenge }`（一次性，120 秒过期）
3. `user.login.verify { name, challenge, response: sha256(challenge + hash), deviceId }` → `{ uid, token }`
   （`deviceId` 必传，任意稳定字符串标识你的客户端）

### 参考实现（Node ≥18，可直接拷贝）

```js
const crypto = require('crypto');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const ROUTER = 'http://localhost:8600/jsonrpc';   // 换成实际地址

async function rpc(method, params, token) {
    const res = await fetch(ROUTER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    });
    const { result, error } = await res.json();
    if (error) throw new Error(`[${error.code}] ${error.message}`);
    return result;
}

// —— 管理员登录 → token ——
async function adminLogin(username, password) {
    const { challenge, salt, iterations } = await rpc('admin.login.request', { username });
    const loginHash = crypto.pbkdf2Sync(password + username, Buffer.from(salt, 'hex'),
        iterations, 32, 'sha256').toString('hex');
    const { token } = await rpc('admin.login.verify',
        { username, challenge, response: sha256(challenge + loginHash) });
    return token;
}

// —— 普通用户注册 + 登录 → { uid, token } ——
async function userLogin(name, password, deviceId = 'my-agent') {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = sha256(password + salt);
    await rpc('user.register', { name, salt, hash })
        .catch(e => { if (!/exists/i.test(e.message)) throw e; });   // 已存在 → 直接登录
    const { challenge } = await rpc('user.login.request', { name });
    return rpc('user.login.verify', { name, challenge, response: sha256(challenge + hash), deviceId });
}
```

> 注意：账号已存在时跳过 register 直接登录的前提是你仍持有当初的 password
> （hash 由它派生）。salt 服务端会在 login 流程里配合，无需本地留存。

## 3. 错误码约定

| code | 含义 | 处理建议 |
|---|---|---|
| -32600 / -32601 / -32602 | 请求格式 / 方法不存在 / 参数错误 | 修请求，别重试 |
| -32603 | 服务端内部错误 | 可少量重试 |
| -32000 | 引导/信任锚缺失等服务端区错误 | 看 message |
| -32001 | 需要认证（token 缺失/过期） | 重新登录 |
| -32003 / -32005 | 无权限（数据级） | 换有权限的账号 |
| -32604 | 方法级权限拒绝（Router checkAccess） | 该方法未授权给你 |
| -32002 / -32004 | 资源不存在 / 已存在 | 业务分支处理（幂等常用 -32004） |
| -32006 / -32007 | 服务未就绪 / 瞬态错误 | 退避后重试 |
| -32029 | 触发限流 | 按 message 中的窗口退避重试 |
| -32099 | 下游服务不可达 | 退避后重试，仍失败则报告人工 |

## 4. 全局约定与硬限制

- **限流真实存在**：批量灌数据请串行或小并发，遇 -32029 退避。
- **参数约束是机读的**：各方法 `params` 里的 `maxLength` / `required` / `pattern`
  在自省数据里原样可见（如 `storage.asset.upload` 的 `file` 参数
  `maxLength: 5242880` = base64 后 5MB 上限）。写调用代码前先读它，别猜。
- **`status` 是软删保留字**：开软删的实体删除时被置为 `DELETED` 并从默认 list 隐形。
  **不要把业务状态塞进 `status`**，另起字段。
- **实体嵌套 ≤ 3 层**；外键命名 `{targetService}Id`。
- **批量写入建议带来源标记**（如在自由扩展字段中记 `source: "<你的代理名>"`），
  便于人工复核区分代理写入与人工写入。

## 5. 下一步（发现链）

1. **登录**（上文）→ 拿 token。
2. `system.service.list` → 全部在线服务 + 每个方法的签名 + 实体 schema
   （生产环境该方法需认证，匿名调用会被拒——所以先登录）。
3. `system.guide { service: "<name>" }` → 该服务的**任务配方**（GUIDE.md：跨方法的
   操作顺序、幂等键、字段约定）。服务未提供时明确返回 `available: false`。
4. 照配方逐步调用；参数约束以 `system.service.list` 返回的机读 schema 为准。

一句话总结给 AI 代理：**先 `system.guide` 学会登录，登录后 `system.service.list`
看有什么，再 `system.guide {service}` 学怎么做，最后动手。**

## 6. 做不到时怎么办（提需求通道）

按配方推进时如果发现**系统满足不了任务**——缺方法、缺参数、返回字段不够、
文档说不清、调用链中途断——**不要静默放弃，也不要绕野路子**，调这个接口把缺口
提上来（匿名可调，无需 token）：

```
system.report {
  type:    "missing_capability",   // 或 bad_returns | unclear_description | chain_failure | other
  method:  "storage.asset.upload", // 相关方法名，没有明确对象可省略
  message: "想 X，但 Y 做不到；期望的能力是 Z",   // ≤1000 字，说清「任务是什么 + 卡在哪 + 期望什么」
  context: { ... }                 // 可选：复现参数、报错原文等结构化上下文
}
```

- 返回 `{ received, reportId, count }`——`count > 1` 说明别的调用方也撞过同一堵墙，
  你的提交增加了它的优先级权重。
- **同一诉求提一次就够**：完全相同的内容重复提交只会累计计数，不会刷屏。
- 提交后**继续或终止你的任务都行**，报告会进入人工 triage（有专门的后台看板），
  被采纳的能力会在后续版本出现在 `system.service.list` / guide 里。
