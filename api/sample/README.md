# Sample Microservice Template

This service demonstrates the standard modular architecture for the Solo·AI microservices ecosystem. It is designed to be **AI-Developer Friendly** (low token usage context) and highly maintainable.

## Structure

```
api/sample/
├── config.js           # Configuration (ports, descriptions, pageSize)
├── index.js            # Orchestrator (Startup, Routing)
├── handlers/           # Infrastructure Logic (Reusable)
│   ├── auth.js         # Authentication (Seeds, Signatures)
│   ├── bootstrap.js    # Redis Connection, Index Creation
│   ├── entities.js     # Data Entity Schemas (for UI & Discovery)
│   ├── jsonrpc.js      # JSON-RPC 2.0 Protocol & Error Catalog
│   └── introspection.js # JSON-RPC Method Definitions
└── logic/              # Business Logic (Domain Specific)
    ├── index.js        # Logic Factory/Aggregator
    ├── sample.js       # Custom Business Logic
    └── item.js         # Standard CRUD Entity (using Shared Factory)
```

---

## Shared Libraries (`api/library`)

To ensure architectural consistency and reduce boilerplate, services **MUST** utilize the shared libraries located in `api/library`.

| Library | Function | Usage Requirement |
| :--- | :--- | :--- |
| `entity.js` | **Mandatory** for CRUD. Handles Redis storage, IDs, and indexing. | `require('../../library/entity')(redis, options)` |
| `jsonrpc.js` | **Mandatory** for Protocol. Provides standard response wrappers. | `require('../handlers/jsonrpc')` (Local Wrapper) |
| `auth.js` | **Mandatory** for Security. Implements Z-Handshake. | Copy to `handlers/auth.js` |
| `category.js` | Shared logic for categories with global Router registration. | `require('../../library/category')(redis, config)` |
| `logger.js` | Structured logging. **Replaces console.log**. | `require('../../library/logger').createLogger('service')` |
| `crypto.js` | **Mandatory** for Security. Handles PBKDF2/AES-GCM. | `require('../../library/crypto')` |

### WAL Context (Mandatory)

Every microservice **MUST** wrap its JSON-RPC handler with `walContext.run()` to inject the current user's UID into WAL audit logs. This enables data change attribution without modifying any business logic.

```javascript
const { walContext } = require('../../library/entity');

app.post('/jsonrpc', authHandlers.middleware, async (req, res) => {
    // WAL context: inject user uid for audit logging
    await walContext.run({ uid: req.user || null }, async () => {
        // ... JSON-RPC dispatch logic ...
    }); // walContext.run
});
```

**Rules**:
- `walContext.run()` must wrap the **entire** request handler body
- Use `req.user?.uid` (BS58 UID), never username — minimizes exposure if logs leak
- If `req.user` is unavailable (public methods), `uid` defaults to `null`

---

## Core Pattern: Entity Factory (CRUD)

**Do not implement manual CRUD.** Use the Shared Entity Factory to ensure consistency, correct ID generation, and RediSearch integration.

### 1. Implementation (`logic/item.js`)
```javascript
const createEntity = require('../../library/entity');

module.exports = (redis, context) => {
    // 1. Create the entity manager
    const itemEntity = createEntity(redis, {
        serviceName: 'sample',     // Matches config.serviceName
        entityName: 'item',        // The entity type
        idPrefix: '',             // MUST be empty. Prefixes are forbidden for simplicity.
        idLength: 8,               // Auto-generated Base58 ID length
        softDelete: true           // Enable soft delete (status=DELETED)
        // searchIndex: 'idx:sample:item' (Optional, auto-inferred)
    });

    // 2. (Optional) Extend or Override methods
    const originalCreate = itemEntity.create;
    itemEntity.create = async (params) => {
        // ... custom validation ...
        return originalCreate(params);
    };

    return itemEntity;
};
```

### 2. Available Methods
The factory automatically provides:
- `create(params)`: Generates ID, sets timestamps, saves to Redis.
- `get({ id })`: Fetches by ID. Throws `RESOURCE_NOT_FOUND` if missing.
- `update({ id, ...updates })`: Partial update. Updates `updatedAt`.
- `delete({ id })`: Soft delete (sets status=DELETED, adds `deletedAt`).
- `list(params)`: Pagination support (`limit`, `offset`), filtering.
- `restore({ id })`: Restores a soft-deleted item.
- `destroy({ id })`: Hard delete (physically removes key).

---

## RediSearch Integration Pattern

Use RediSearch when your entity will grow beyond ~2万 records, or when you need server-side filtering on specific fields (foreign keys, categories, status).

### Decision Table

| Entity Size | Pattern | Implementation |
|---|---|---|
| < 2万 | `SMEMBERS → mGet → applySearch` | `library/search.js` |
| 2万 ~ 10万 | same + `batchSize` option | `entity.list({ batchSize: 2000 })` |
| > 10万 | RediSearch `FT.SEARCH` | custom `*_search.js` + `storageType: 'json'` |

### Step 1 — Enable JSON Storage

```javascript
// logic/item.js
const itemEntity = createEntity(redis, {
    serviceName: 'sample',
    entityName: 'item',
    softDelete: true,
    storageType: 'json',   // ← required for RediSearch ON JSON
});
```

### Step 2 — Create Search Module (`logic/item_search.js`)

```javascript
const { escapeTag } = require('../../../library/search');

const INDEX_NAME = 'idx:sample_item';
const PREFIX     = 'SAMPLE:ITEM:';

async function ensureItemIndex(redis) {
    await redis.sendCommand(['FT.CONFIG', 'SET', 'MAXSEARCHRESULTS', '-1']);
    try { await redis.sendCommand(['FT.DROPINDEX', INDEX_NAME]); } catch (_) {}

    await redis.sendCommand([
        'FT.CREATE', INDEX_NAME,
        'ON', 'JSON',
        'PREFIX', '1', PREFIX,
        'SCHEMA',
        '$.name',      'AS', 'name',       'TAG', 'WITHSUFFIXTRIE',
        '$.category',  'AS', 'category',   'TAG',
        '$.status',    'AS', 'status',     'TAG',
        '$.createdAt', 'AS', 'created_at', 'NUMERIC', 'SORTABLE',
    ]);
}

async function searchItem(redis, { keyword, category, status = 'ACTIVE', limit = 50, offset = 0 } = {}) {
    const parts = [`@status:{${escapeTag(status)}}`];
    if (category) parts.push(`@category:{${escapeTag(category)}}`);
    if (keyword) {
        const kw = escapeTag(keyword.trim());
        parts.push(`@name:{*${kw}*}`);
    }

    const result = await redis.ft.search(INDEX_NAME, parts.join(' '), {
        LIMIT: { from: offset, size: limit },
        SORTBY: { BY: 'created_at', DIRECTION: 'DESC' },
    });
    return { items: result.documents.map(d => d.value), total: result.total };
}

module.exports = { ensureItemIndex, searchItem };
```

### Step 3 — Wire in `handlers/bootstrap.js`

```javascript
const { ensureItemIndex } = require('../logic/item_search');

async function initializeRedis(SERVICE_NAME) {
    // ... existing connect logic ...

    try {
        await ensureItemIndex(redisClient);
        logger.info('RediSearch index idx:sample_item ready');
    } catch (e) {
        logger.error('Failed to create RediSearch index:', e.message);
    }

    return redisClient;
}
```

### Step 4 — Create Migration Script (`deploy/migrate/sample_item_to_json.js`)

Existing string keys must be converted once before RediSearch can index them:

```bash
cd deploy/migrate
node sample_item_to_json.js --dry-run   # preview
node sample_item_to_json.js             # execute
```

Pattern: `TYPE` check → skip `ReJSON-RL` → `GET` → `DEL` → `JSON.SET`. See `deploy/migrate/qr_to_json.js` for reference.

### Schema Field Types

| Field Type | When to Use | Example |
|---|---|---|
| `TAG` | Exact match, category, FK, status | `$.status AS status TAG` |
| `TAG WITHSUFFIXTRIE` | Substring search (`*kw*`) | `$.name AS name TAG WITHSUFFIXTRIE` |
| `NUMERIC SORTABLE` | Sort, range filter (timestamps, amounts) | `$.createdAt AS created_at NUMERIC SORTABLE` |
| `TEXT` | Full-text (Chinese: avoid — use TAG instead) | N/A |

### Common Pitfalls

```javascript
// ❌ meta overwrite — will clear nested fields
await entity.update({ id, meta: { field: value } });

// ✅ spread first
const existing = await entity.get({ id });
await entity.update({ id, meta: { ...existing.meta, field: value } });

// ❌ don't reimplement escapeTag
function myEscape(s) { return s.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~]/g, '\\$&'); }

// ✅ single source
const { escapeTag } = require('../../library/search');

// ❌ TAG {*} wildcard — NOT supported in RediSearch 2.10, causes syntax error
parts.push('@target_type:{*}');    // "has any value" — BROKEN
parts.push('-@target_type:{*}');   // "has no value"  — BROKEN

// ✅ TAG fields do NOT index null values — use an explicit NUMERIC flag instead
// In schema: '$.isBound', 'AS', 'is_bound', 'NUMERIC'
// On create: isBound: 0  (unbound)
// On bind:   isBound: 1  (bound)
parts.push('@is_bound:[1 1]');     // bound
parts.push('@is_bound:[0 0]');     // unbound
```

> **Rule**: Never rely on TAG null-absence for filtering. If you need "field has a value" vs "field is empty", store an explicit `NUMERIC` flag (0/1). TAG fields that are `null` or missing are silently skipped by the indexer — `{*}` cannot detect them.

---

## Data Schema Best Practices

To ensure long-term flexibility and AI compatibility, follow these schema patterns:

### 1. The `ext` (Extension) Object
**Every entity MUST include an `ext: {}` field.** 
- **Purpose**: Store dynamic metadata, UI state, or AI-generated attributes without changing the core schema.
- **Rules**: 
    - Must be a **Flat JavaScript Object** (No deep nesting).
    - **Self-adaptive UI Pattern**: Use underscores for namespacing to keep the object flat. This allows the Portal UI to automatically render individual fields without complex recursion.
        - **Correct**: `ext.erp_code = "..."`, `ext.dingtalk_id = "..."`.
        - **Incorrect**: `ext.erp = { code: "..." }`.
    - DO NOT store large binary data or logs here.
    - Used for features like `icons`, `custom_tags`, or `ai_priority_score`.

### 2. Time-Series vs Snapshots
- For historical data (like logic/approval.js), capture a **snapshot** of rules at creation time rather than just referencing a Template ID.

---

## JSON-RPC Protocol Standards (Strict)

To maintain microservice autonomy and protocol consistency, every service **MUST** follow the `jsonrpc.js` pattern.

### 1. File Structure
```text
handlers/
└── jsonrpc.js  <-- MUST exist and be used by index.js
```

### 2. Strict Rule (Enforced by Autocheck)
- **Do NOT** import `library/jsonrpc` directly in `index.js`.
- **ALWAYS** use the local `handlers/jsonrpc.js` wrapper to terminate responses.

### 3. Usage in Logic
```javascript
const jsonrpc = require('../handlers/jsonrpc');

async function doSomething(params) {
    if (!params.id) throw jsonrpc.INVALID_REQUEST('Missing ID');
    // ...
}
```

---

## Testing

测试分两层,**别混用**:

| 层 | 测什么 | 放哪 | 何时跑 |
|----|--------|------|--------|
| **单元(hermetic)** | 注入 fake redis,测本服务 `logic/*` 的行为与分支。不起栈、不连真 Redis、不走 Router;毫秒级、确定性。 | 本服务 `tests/*.test.js` | 进 `api/jest.ci.config.js` 白名单 → 每次 push |
| **e2e(集成)** | 真起全栈,验跨服务接线 / 事件链 / 真实投递。 | repo 根 `e2e/`(full profile) | 手动 / 集成阶段 |

**范本**:[`tests/item.test.js`](./tests/item.test.js) —— 照抄它的结构:

1. 顶部设 `process.env.LOG_DIR`(指到临时目录,避免 WAL 写进 `api/logs`),**必须在 require logic 之前**(logger 在加载时读 `LOG_DIR`)。
2. `makeFakeRedis()`:`Map` 支撑,只实现你 logic 真正用到的命令(Entity Factory 字符串路径要 `get / set(NX) / del / mGet`、`sAdd / sMembers / sRem`、`multi().set().sAdd().exec()`;没 `duplicate()` 时 `library/optimistic.js` 自动退回普通读改写)。
3. `beforeEach` 重建 redis + logic 工厂;`test()` 调方法、`expect()` 断言。

```js
const item = createItemLogic(makeFakeRedis(), { serviceName: 'sample', idLengths: { item: 16 } });
const created = await item.create({ name: 'widget' });
expect(created.status).toBe('ACTIVE');
```

**红线**:
- ✅ 写 `describe / test / expect` 的 **jest** 测试。
- ❌ 别写 `process.exit()` 脚本 —— 进不了 CI 白名单,CLAUDE.md §6 已点名这是非 hermetic 的反面。
- ❌ 别在单测里 mock 半个系统去模拟跨服务调用 —— 那是 e2e 的活。
- 写完把文件加进 `api/jest.ci.config.js` 的白名单,`cd api && npx jest -c jest.ci.config.js` 跑绿。

```bash
cd api && npx jest sample/tests        # 跑本服务的单测
```

> `introspection 声明 ↔ index.js 注册` 这条红线由 `deploy/check-doc-drift.js`(CI)守护,无需每个服务自己写测试去查。

---

## How to Create a New Service

1. **Copy**: `cp -r api/sample api/apps/your-service`
2. **Configure**: Update `config.js` (port, serviceName, redisUrl).
3. **Clean Up**: Remove `logic/sample.js` and `logic/item.js`, create your own domain logic.
4. **Implement Logic**: Use `createEntity` for your data models.
5. **Wire Up**: Update `logic/index.js` and `index.js`.
6. **Introspection**: Update `handlers/introspection.js` to match your new methods.
7. **Test**: 仿 `tests/item.test.js` 写 hermetic 单测(注入 fake redis 测你的 `logic/*`),加进 `api/jest.ci.config.js` 白名单。见 [Testing](#testing)。
8. **Verify**:
   ```bash
   # CRITICAL STEP
   node api/autocheck/checker.js api/apps/your-service --static
   ```
   *You must fix all implementation ERRORS before deployment.*

---

## Autocheck Compliance

This service is monitored by the `autocheck` system.

- **Strict Mode**: Services under `api/apps/` are checked strictly.
- **Forbidden**:
  - `console.log` in `logic/` or `handlers/` (Use Logger).
  - Manual CRUD without Entity Factory.
  - Direct use of express `res.send` (Use jsonrpc handler).

Run check manually:
```bash
node api/autocheck/checker.js api/sample --static
```

---

## Microservice-Portal Integration

### 1. Unified Infrastructure Methods
These methods are auto-wired if you copy the sample `index.js`:
- `ping`: Health check.
- `methods`: Returns `handlers/introspection.js`.
- `entities`: Returns `handlers/entities.js`.

### 2. Tab Visibility Requirements (Discovery Protocol)
For an entity to automatically appear as a Tab in the Operator Console, it **MUST** satisfy:
- **Action Naming**: The service must expose `{service}.{entity}.list` AND `{service}.{entity}.create`. The presence of `.create` is the trigger for the UI to consider it a "Manageable Entity".
- **Key Consistency**: The key in `handlers/entities.js` must exactly match the `{entity}` segment in the RPC methods.
- **UI Metadata**: The entity in `entities.js` must have a `ui: { label, icon, priority }` block.
- **Method Params**: For auto-generated forms, the `.create` method in `introspection.js` should ideally have `params: []`. The UI will build the form fields dynamically from the `entities.js` schema.

> [!TIP]
> **Custom App Pages**: Some Apps (like Asset) use specialized React components instead of Generic ones. In such cases, adding a new entity to the backend isn't enough; you must also manually register the Tab in the frontend component (e.g., `portal/operator/src/pages/storage/index.tsx`).

### 3. Auth Whitelist
Ensure `handlers/auth.js` allows these methods through for discovery.

```javascript
const PUBLIC_METHODS = ['ping', 'methods', 'entities'];
if (req.body && PUBLIC_METHODS.includes(req.body.method)) return next();
```
