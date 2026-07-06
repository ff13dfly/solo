/**
 * library/jsonrpc.js — JSON-RPC 2.0 协议工具与错误目录
 *
 * 两种用途：
 *   1. logic 层抛出错误：throw jsonrpc.NOT_FOUND('Order')
 *   2. HTTP 层发送响应：jsonrpc.success(res, result, id)
 *
 * 各服务 handlers/jsonrpc.js 直接 re-export，并可追加服务专有错误：
 *   module.exports = { ...require('../../library/jsonrpc'), MY_ERROR: () => ({...}) };
 */

// ── HTTP 响应包装 ────────────────────────────────────────────────────────────

const wrap = (res, data, id, isError) => {
    const payload = {
        jsonrpc: '2.0',
        id: (id === undefined || id === null) ? null : id,
    };
    if (isError) {
        const { id: _, ...errorBody } = data;
        payload.error = { message: data.message, ...errorBody };
    } else {
        payload.result = data;
    }
    return res.json(payload);
};

const success = (res, result, id) => wrap(res, result, id, false);

const error = (res, err, id, httpStatus = 200) => {
    if (httpStatus !== 200) res.status(httpStatus);
    return wrap(res, err, id, true);
};

// ── 标准协议错误（JSON-RPC 2.0） ──────────────────────────────────────────────

const INVALID_REQUEST  = ()       => ({ code: -32600, message: 'Invalid Request' });
const METHOD_NOT_FOUND = (method) => ({ code: -32601, message: `Method ${method} not found` });
const INVALID_PARAMS   = (msg)    => ({ code: -32602, message: msg || 'Invalid params' });
const MISSING_PARAM    = (name)   => ({ code: -32602, message: `Missing parameter: ${name}` });
const INTERNAL_ERROR   = (msg)    => ({ code: -32603, message: msg || 'Internal Error' });

// ── 安全 / 权限错误 ───────────────────────────────────────────────────────────

const AUTH_REQUIRED      = ()       => ({ code: -32001, message: 'Authorization Required' });
const INVALID_SIGNATURE  = ()       => ({ code: -32001, message: 'Invalid Router Signature' });
const UNAUTHORIZED       = ()       => ({ code: -32003, message: 'Unauthorized' });
const FORBIDDEN          = (reason) => ({ code: -32005, message: reason || 'Forbidden' });

// ── 基础设施错误 ──────────────────────────────────────────────────────────────
// SERVICE_NOT_READY: HTTP 监听已起但 Methods 尚未初始化（Redis 连接中等）的引导窗口。
// 各服务 `if (!Methods)` 守卫统一用它，返回 503 + 标准信封（旧代码有裸 {error:string} 漂移）。
const SERVICE_NOT_READY  = ()       => ({ code: -32006, message: 'Service not ready' });

// ── 业务域错误 ────────────────────────────────────────────────────────────────

const NOT_FOUND      = (entity = 'Resource') => ({ code: -32002, message: `${entity} not found` });
const ALREADY_EXISTS = (entity = 'Resource') => ({ code: -32004, message: `${entity} already exists` });

// ── 兼容旧名称 ────────────────────────────────────────────────────────────────
// logic 层部分代码用 INVALID_PARAM（无 S），保持向后兼容
const INVALID_PARAM = INVALID_PARAMS;
const RESOURCE_NOT_FOUND = NOT_FOUND;

// ── 错误码中央登记表（唯一真源） ──────────────────────────────────────────────
// 全系统在用的每一个 JSON-RPC 错误码都登记在此：canonical = 规范名，aliases = 该码
// 下允许的服务专属别名（同码同义，不同 message）。`deploy/check-error-codes.js` 据此
// 守门：任何 handlers/jsonrpc.js 里出现的码必须登记，未登记的别名 = CI 红线（防撞码）。
// 扩展码（-32000..-32099 服务端区）登记 defined-in，便于追溯。
const CODES = {
    // — 标准协议（JSON-RPC 2.0）—
    '-32600': { canonical: 'INVALID_REQUEST',  aliases: [] },
    '-32601': { canonical: 'METHOD_NOT_FOUND', aliases: [] },
    '-32602': { canonical: 'INVALID_PARAMS',   aliases: ['MISSING_PARAM', 'INVALID_PARAM'] },
    '-32603': { canonical: 'INTERNAL_ERROR',   aliases: ['INVALID_CHALLENGE', 'UPLOAD_FAILED', 'AUTH_FAILED'] },
    // — 认证 / 引导（服务端区）—
    '-32000': { canonical: 'TRUST_ANCHOR_MISSING', aliases: ['MALFORMED_TOKEN'], note: 'router-auth bootstrap' },
    '-32001': { canonical: 'AUTH_REQUIRED', aliases: ['INVALID_SIGNATURE', 'ACCOUNT_DELETED', 'AUTH_FAILED', 'MISSING_AUTH'] },
    '-32003': { canonical: 'UNAUTHORIZED', aliases: [] },
    '-32005': { canonical: 'FORBIDDEN', aliases: [] },
    // — 基础设施 / 瞬态 —
    '-32006': { canonical: 'SERVICE_NOT_READY', aliases: [] },
    '-32007': { canonical: 'RETRY_LATER', aliases: [], note: 'agent transient (was -32099, de-collided)' },
    '-32029': { canonical: 'RATE_LIMIT_EXCEEDED', aliases: [], note: 'router-defined' },
    '-32099': { canonical: 'UPSTREAM_ERROR', aliases: [], note: 'router-defined; sole owner of -32099' },
    // — 业务域 —
    '-32002': { canonical: 'NOT_FOUND', aliases: ['RESOURCE_NOT_FOUND', 'USER_NOT_FOUND', 'ASSET_NOT_FOUND'] },
    '-32004': { canonical: 'ALREADY_EXISTS', aliases: [] },
    // — router 内部 inline（非 helper，登记以求覆盖；非 shim 守门范围）—
    '-32010': { canonical: 'CATEGORY_INVALID', aliases: [], note: 'router/handlers/category.js inline' },
    '-32011': { canonical: 'CATEGORY_NOT_FOUND', aliases: [], note: 'router/handlers/category.js inline' },
    '-32012': { canonical: 'CATEGORY_PERMISSION_DENIED', aliases: [], note: 'router/handlers/category.js inline' },
    '-32604': { canonical: 'ACCESS_DENIED', aliases: [], note: 'router method-level access-denied (permission gate); documented in permission-system.md. INTENTIONALLY distinct from -32005 FORBIDDEN (service/data-level).' },
};

// ── 向外暴露（plain object 形式，支持解构扩展） ──────────────────────────────

module.exports = {
    // HTTP helpers
    success, error,
    // Protocol errors
    INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INVALID_PARAM,
    MISSING_PARAM, INTERNAL_ERROR,
    // Auth errors
    AUTH_REQUIRED, INVALID_SIGNATURE, UNAUTHORIZED, FORBIDDEN,
    // Infrastructure errors
    SERVICE_NOT_READY,
    // Business errors
    NOT_FOUND, RESOURCE_NOT_FOUND, ALREADY_EXISTS,
    // Central code registry (single source of truth; guarded by deploy/check-error-codes.js)
    CODES,
};
