# API Administrator

> 管理员认证与系统管理服务，负责后台登录验证和系统级操作。

## 定位

System Portal 的后台身份层 + 系统级操作面：单管理员登录（挑战-响应）、错误日志、服务级 config/index override。**不是** 普通用户账号体系（那是 `user` 服务）——这里只有一个主管理员。

> **方法清单与参数以 introspection 为准** —— 调 `system.introspect` 或读本服务 `handlers/introspection.js`（声明↔注册由 `deploy/check-doc-drift.js` CI 守护）。

## 目录结构

```
api/core/administrator/
├── index.js              # 服务入口
├── config.js             # 配置（端口、Redis key、种子管理员）
├── package.json          # 依赖声明
├── handlers/
│   └── introspection.js  # 能力自省
├── logic/
│   ├── identity.js       # 身份认证逻辑（核心）
│   └── error.js          # 错误处理
└── tests/
    ├── identity.test.js
    └── handlers.test.js
```

---

## 🔐 管理员登录信息初始化

### 存储位置

管理员用户信息存储在 **Redis** 中：

| Key | 类型 | 说明 |
|-----|------|------|
| `administrator:user:{username}` | String (JSON) | 唯一管理员数据 |

> [!IMPORTANT]
> **单管理员模型**：本系统仅通过一个主管理员账号进行管理。不支持、也不建议创建多个操作员账号，以实现最小化的攻击面。

## 🛡️ 安全架构：引导与自毁机制

该服务采用了“引导-自毁”模型，旨在彻底消除微服务中常见的“默认密码哈希”漏洞。

### 1. 引导阶段 (Bootstrap Phase)
- **唯一凭证源**：系统启动时不读取任何环境变量中的固定密码。唯一的“保底”入口是根目录下的 `seed.json` 文件。
- **运行时加载**：`identity` 逻辑会检测 Redis。若 Redis 为空，则临时信任 `seed.json` 中的数据。

### 2. 转换与锁定 (Transition & Lock)
- **原子重置**：管理员通过执行 `admin.password.reset` RPC 方法，将密码迁移到 Redis 持久化存储。
- **物理自毁**：一旦写入 Redis 成功，系统会**立即执行物理删除** `seed.json` 的操作。

### 3. 防降级保护 (Anti-Downgrade)
- **状态锁定**：文件删除后，系统不再具备任何回退路径。
- **失效安全 (Fail-Safe)**：即使黑客攻破 Redis 并执行 `FLUSHALL` 清空数据，系统也不会回退到初始状态，而是会因为找不到用户而拒绝访问（Lockout），从而保证了修改后的密码不会因为数据库清空而导致“默认密码重现”。

### 🚨 灾难恢复：忘记密码怎么办？

由于系统采用了自毁机制，一旦 `seed.json` 消失，没有“忘记密码”重置链接。若管理员密码遗忘，请执行以下物理操作：

1.  **清空 Redis 记录**：
    使用终端进入服务器，执行：
    ```bash
    redis-cli DEL "administrator:user:admin" # 假设用户名为 admin
    ```
2.  **重新投放种子**：
    在 `api/core/administrator/` 目录下重新创建一个 `seed.json` 文件（内容包含初始的 `username` 和 `login_hash`）。
3.  **重新验证并重置**：
    使用临时密码登录后，通过 System Portal 调用 `admin.password.reset` 设置新密码，系统将再次进入锁定状态。

---

## 🚀 部署脚本：初始化管理员

### 方式一：通过 Redis CLI 直接写入

```bash
# 生成哈希后，直接写入 Redis
redis-cli SET "administrator:user:admin" '{"username":"admin","salt":"YOUR_SALT","iterations":200000,"login_hash":"YOUR_HASH","role":"admin"}'
redis-cli SADD "administrator:users" "admin"
```

### 方式二：使用初始化脚本

创建 `scripts/init_admin.js`：

```javascript
const crypto = require('crypto');
const { createClient } = require('redis');

async function initAdmin(username, password) {
    const client = createClient();
    await client.connect();

    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = 200000;
    
    const loginHash = crypto.pbkdf2Sync(
        password + username,
        Buffer.from(salt, 'hex'),
        iterations,
        32,
        'sha256'
    ).toString('hex');

    const userData = {
        username,
        salt,
        iterations,
        login_hash: loginHash,
        role: 'admin',
        createdAt: new Date().toISOString()
    };

    await client.set(`administrator:user:${username}`, JSON.stringify(userData));
    await client.sAdd('administrator:users', username);
    
    console.log(`Admin user "${username}" created successfully`);
    console.log('You can now login with the provided password');
    
    await client.disconnect();
}

// 使用方式: node init_admin.js <username> <password>
const [,, username, password] = process.argv;
if (!username || !password) {
    console.log('Usage: node init_admin.js <username> <password>');
    process.exit(1);
}
initAdmin(username, password);
```

---


## 登录流程

```
┌─────────────────────────────────────────────────────┐
│  前端 (System Portal)                               │
├─────────────────────────────────────────────────────┤
│  1. 用户输入 username + password                    │
│  2. 调用 login_request 获取 salt + challenge       │
│  3. 计算 loginHash = PBKDF2(password+username,     │
│                             salt, iterations)       │
│  4. 计算 response = SHA256(challenge + loginHash)  │
│  5. 调用 login_verify 验证                         │
└─────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  后端 (Administrator Service)                       │
|  - 仅支持单管理员账号 (Single Admin)                |
├─────────────────────────────────────────────────────┤
│  login_request:                                     │
│    - 优先从 Redis 加载，无数据则尝试加载 seed.json   │
│    - 返回 salt, iterations, challenge              │
│                                                     │
│  login_verify:                                      │
│    - 获取用户的 login_hash                          │
│    - 计算 expected = SHA256(challenge + login_hash) │
│    - 比较 response === expected                    │
│    - 成功则生成 session token                      │
└─────────────────────────────────────────────────────┘
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8680 | 服务端口 |
| `ROUTER_URL` | http://localhost:8600 | Router 地址 |
| `ROUTER_PUBLIC_KEY` | - | Router 公钥 (用于 Level 3 安全校验) |
| `DEBUG` | true | 调试模式 |

## 运行

```bash
cd api/core/administrator
npm install
node index.js
```

---

## 其它面向 / 方向

- **Just-in-time admin（`admin.self.lock`）**：调用后把当前会话 token 缩短到 60s 并**关闭 administrator HTTP 端口**，把高权窗口压到最小。`index.js` 捕获了 server handle 以便回调里关闭它（见 `index.js` 顶部注释）。
- **服务级 override（`setting.config.*` / `setting.index.schema`）**：administrator 同时承担把 Redis config override 与 RediSearch index schema 暴露给 System Portal 的职责——属于"系统后台"语义，不是身份逻辑。具体方法/参数见 introspection。
- **未实现 / 待办**：种子物理自毁与防降级是核心安全不变量，灾难恢复仍是手工 redis-cli 流程（无自助找回，刻意为之，见上）。
