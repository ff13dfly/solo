/**
 * library/pagination.js — RPC 边界的分页参数归一
 *
 * @why SOLO 里同时存在两套分页方言：早期服务收 `page`/`pageSize`（ingress / notification /
 *      nexus / storage / market / collection），后来的服务收 `limit`/`offset`（orchestrator /
 *      fulfillment），而底层 `library/entity.js` 的 `list()` 只认后者。于是每个收 page 的服务
 *      都在 logic 里手抄同样三行换算——`api/core/ingress/logic/source.js`、`apps/market/logic/
 *      order.js`、`apps/market/logic/shipment.js`、`apps/collection/logic/payment.js` 各抄了一份，
 *      `apps/storage/logic/asset.js` 还多抄了一版带 `??` 回退的变体。抄第五遍时它就该是个库函数。
 *
 *      **全队标准是 `limit`/`offset`/`cursor`**（`autocheck/static/param-conventions.js` 的
 *      FLEET_PARAM_TYPES 是权威表）。`page`/`pageSize` 是历史方言：存量方法继续接受它，
 *      **新方法不要再用**。这个 helper 让"两套都收、内部只有一套"变成一行，从而能在不破坏
 *      任何现存调用方的前提下把标准方言加进去。
 *
 * 用法（服务 logic 层）：
 *   const { resolvePaging } = require('../../library/pagination');
 *   async function list(params = {}) {
 *       const { limit, offset } = resolvePaging(params, { defaultLimit: config.pageSize });
 *       return entity.list({ limit, offset });
 *   }
 */

/**
 * 取正整数，拿不到就用 fallback。
 * 经 Router 进来的值已被 introspection 的 `type: 'number'` 校验过，但内部直调
 * （relay / 测试 / workflow）不过那道关，所以这里自己兜底，不假设入参已经是数字。
 */
function toPositiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 把调用方可能用的任意一套分页参数，归一成 `entity.list()` 认的形状。
 *
 * @param {object} params  RPC 收到的原始 params（可含 page/pageSize/limit/offset/cursor）
 * @param {object} [opts]
 * @param {number} [opts.defaultLimit=20]  两套都没传时的页大小，通常传 `config.pageSize`
 * @returns {{limit: number, offset: number} | {limit: number, cursor: string|null}}
 *
 * 三条优先级，全部有意为之：
 *   1. **`limit`/`offset` 赢过 `page`/`pageSize`**。两套都传时以标准方言为准——`portal/operator`
 *      的通用实体 hook（`pages/default/hooks/useEntityQuery.ts`）当年就是靠"四个参数一起发"
 *      绕开方言分裂的，它发来的两套值本就等价，取哪套结果一样；而将来有人只改前端为标准方言时，
 *      这个优先级保证改动立刻生效。
 *   2. **`cursor` 键存在（哪怕值是 `null`）就走游标模式**，且不产生 `offset`。这与
 *      `entity.list()` 的 `cursor !== undefined` 判定完全一致：`null` = 请求第一页，
 *      不传这个键 = 明确要 offset 模式。别把 `cursor: null` "顺手清理掉"，那会静默切回慢路径。
 *      ⚠️ 游标模式返回 `{items, nextCursor}` 而非 `{items, total}`——服务要开它，
 *      `returns`/`returns_schema` 必须同步改（`total` 不能再声明 required），
 *      且存量实体要先跑一次 `deploy/migrate-cursor-index.js`。
 *   3. **页大小下限是 1**（`Math.max(1, …)` 的等价物，由 toPositiveInt 兜底）。`limit: 0`
 *      在既有服务里一律被当成"没传"，这里保持同样语义，不返回空页。
 *      **不设上限**：e2e 里存在 `pageSize: 1000` 这类"一次拉全量"的合法用法，
 *      加个 maxLimit 会静默截断它们。需要封顶的服务自己 clamp。
 */
function resolvePaging(params = {}, { defaultLimit = 20 } = {}) {
    const src = (params && typeof params === 'object') ? params : {};
    const { page, pageSize, limit, offset, cursor } = src;

    const effLimit = toPositiveInt(limit, toPositiveInt(pageSize, defaultLimit));

    if (cursor !== undefined) {
        return { limit: effLimit, cursor };
    }

    let effOffset;
    if (offset !== undefined && offset !== null) {
        const n = Number(offset);
        effOffset = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } else {
        effOffset = (toPositiveInt(page, 1) - 1) * effLimit;
    }

    return { limit: effLimit, offset: effOffset };
}

module.exports = { resolvePaging };
