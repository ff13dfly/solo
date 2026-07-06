/**
 * 深度验证 helpers — §8 的"四连断言"(①API ②落库 ③日志/WAL ④无异常).
 * 用 node `assert`(框架无关、消息清晰),抛错即 jest 用例失败.
 */
const assert = require('assert');
const wal = require('./wal');
const { scanAll } = require('./redis');

// ── ① API ──────────────────────────────────────────────────────────────────

/** 断言成功并返回 result;有 error 直接抛(带 code+message). */
function assertResult(res, msg = 'RPC') {
    if (res.error) throw new Error(`${msg} failed: [${res.error.code}] ${res.error.message}`);
    assert.ok(res.result !== undefined, `${msg}: no result in response`);
    return res.result;
}

/** 断言是错误;可选断言 code。返回 error。可达性 = code ≠ -32601(METHOD_NOT_FOUND). */
function assertRpcError(res, code, msg = 'expected error') {
    assert.ok(res.error, `${msg}, but got result: ${JSON.stringify(res.result)}`);
    if (code !== undefined) {
        assert.strictEqual(res.error.code, code, `${msg}: code ${res.error.code} ≠ ${code}`);
    }
    return res.error;
}

// ── ② Redis 落库 ─────────────────────────────────────────────────────────────

async function readKey(redis, key) {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * 读回 data key 校验:存在 + 字段子集匹配 + (可选)在 INDEX + 时间不变量.
 * @param {object} opts.indexKey - 若给,断言 record.id ∈ 该 set.
 */
async function assertRecord(redis, key, expected = {}, opts = {}) {
    const rec = await readKey(redis, key);
    assert.ok(rec, `record missing at ${key}`);
    for (const [k, v] of Object.entries(expected)) {
        assert.deepStrictEqual(rec[k], v, `${key}.${k} = ${JSON.stringify(rec[k])} ≠ ${JSON.stringify(v)}`);
    }
    // 不变量:仅当两者都是 ms 整数时比较(user 实体用 ISO,跳过).
    if (typeof rec.createdAt === 'number' && typeof rec.updatedAt === 'number') {
        assert.ok(rec.updatedAt >= rec.createdAt, `${key}: updatedAt(${rec.updatedAt}) < createdAt(${rec.createdAt})`);
    }
    if (opts.indexKey) {
        const member = await redis.sIsMember(opts.indexKey, rec.id);
        assert.ok(member, `${rec.id} not in index ${opts.indexKey}`);
    }
    return rec;
}

// ── ③ 日志 / WAL ─────────────────────────────────────────────────────────────

/**
 * 断言 data key 有一条 op 的 WAL 行;校验 before/after/user.
 * create 行额外断言 before===null(entity.js wal()).
 */
function assertWal(logDir, key, op, expected = {}) {
    const rows = wal.query(key, logDir);
    const row = [...rows].reverse().find((r) => r.op === op);
    assert.ok(row, `no WAL '${op}' row for ${key} (found ${rows.length} rows)`);
    assert.strictEqual(row.key, key, `WAL key mismatch: ${row.key} ≠ ${key}`);
    if ('user' in expected) {
        assert.strictEqual(row.user, expected.user, `WAL user = ${row.user} ≠ ${expected.user}`);
    }
    if (op === 'create') assert.strictEqual(row.before, null, `WAL create.before ≠ null`);
    if (expected.after) {
        for (const [k, v] of Object.entries(expected.after)) {
            assert.deepStrictEqual(row.after?.[k], v, `WAL after.${k} = ${JSON.stringify(row.after?.[k])} ≠ ${JSON.stringify(v)}`);
        }
    }
    return row;
}

/** happy-path:相关服务的 ERROR:QUEUE:{svc} 都空(无 services 则扫全部). */
async function assertNoErrors(redis, services) {
    const names = services
        || (await scanAll(redis, 'ERROR:QUEUE:*')).map((k) => k.replace('ERROR:QUEUE:', ''));
    const dirty = [];
    for (const svc of names) {
        const n = await redis.lLen(`ERROR:QUEUE:${svc}`);
        if (n > 0) {
            const sample = await redis.lRange(`ERROR:QUEUE:${svc}`, 0, 2);
            dirty.push(`${svc}(${n}): ${sample.join(' | ')}`);
        }
    }
    assert.strictEqual(dirty.length, 0, `ERROR:QUEUE not empty:\n  ${dirty.join('\n  ')}`);
}

// ── ④ 异常数据检测(keyspace 快照-diff) ──────────────────────────────────────

async function snapshotKeyspace(redis) {
    return new Set(await scanAll(redis, '*'));
}

/**
 * diff 两次快照:返回 { added, unexpected }.
 * unexpected = 新增且不以任何 allowPrefixes 开头的 key(= §8.4 异常).
 */
function diffKeyspace(before, after, allowPrefixes = []) {
    const added = [...after].filter((k) => !before.has(k));
    const unexpected = added.filter((k) => !allowPrefixes.some((p) => k.startsWith(p)));
    return { added, unexpected };
}

module.exports = {
    assertResult, assertRpcError,
    readKey, assertRecord,
    assertWal, assertNoErrors,
    snapshotKeyspace, diffKeyspace,
};
