/**
 * report.test.js — system.report 提报通道 hermetic 单测。
 *
 * 锁住 2026-07-23 的闭环增强（docs/feedback/ai-agent-self-describing-api.md 后续）：
 *   - 指纹去重：同 type|method|message(规范化) 重复提交 → count+1，不新增条目
 *   - triage 状态：NEW → REVIEWED/RESOLVED（admin），非法状态拒
 *   - list 过滤：type / status
 *   - 旧格式兼容：v1.1.11 前的条目（无 count/status）读出时补默认值
 *   - 容量裁剪时同步清 FP 去重索引（防 hash 泄漏堆积）
 */
const createReportHandlers = require('../handlers/report');

// 内存 fake：zset(按 score 排序) + hash，覆盖 report.js 用到的全部命令
function fakeRedis() {
    let zset = [];                 // [{ score, value }]
    const hash = new Map();
    return {
        _zset: () => zset, _hash: () => hash,
        async zAdd(_, { score, value }) { zset.push({ score, value }); zset.sort((a, b) => a.score - b.score); },
        async zRem(_, value) { zset = zset.filter(e => e.value !== value); },
        async zCard() { return zset.length; },
        async zRange(_, start, stop, opts = {}) {
            const arr = (opts.REV ? [...zset].reverse() : zset).map(e => e.value);
            const end = stop === -1 ? arr.length : stop + 1;
            return arr.slice(start, end);
        },
        async zRangeWithScores(_, start, stop, opts = {}) {
            const arr = opts.REV ? [...zset].reverse() : [...zset];
            const end = stop === -1 ? arr.length : stop + 1;
            return arr.slice(start, end);
        },
        async zRemRangeByRank(_, start, stop) { zset.splice(start, stop - start + 1); },
        async hGet(_, f) { return hash.get(f) ?? null; },
        async hSet(_, f, v) { hash.set(f, v); },
        async hDel(_, f) { hash.delete(f); },
    };
}

function fakeRes() {
    return { body: null, json(x) { this.body = x; return this; } };
}

async function submit(h, params) {
    const res = fakeRes();
    await h.submit(params, 1, res);
    return res.body;
}

describe('system.report', () => {
    let redis, h;
    beforeEach(() => { redis = fakeRedis(); h = createReportHandlers(redis); });

    test('submit: 基本提交，返回 reportId + count=1，未知 type 归 other', async () => {
        const out = await submit(h, { type: 'nonsense', message: 'need X' });
        expect(out.result).toMatchObject({ received: true, count: 1 });
        expect(out.result.reportId).toBeTruthy();

        const res = fakeRes();
        await h.list({}, 2, res, true);
        expect(res.body.result.total).toBe(1);
        expect(res.body.result.items[0]).toMatchObject({ type: 'other', status: 'NEW', count: 1 });
    });

    test('submit: 缺 message 拒 -32602', async () => {
        const out = await submit(h, { type: 'other' });
        expect(out.error.code).toBe(-32602);
    });

    test('去重：同诉求（空白/大小写差异归一）count 累计，不新增条目', async () => {
        await submit(h, { type: 'missing_capability', method: 'a.b.c', message: 'Need   Bulk Upload' });
        const dup = await submit(h, { type: 'missing_capability', method: 'a.b.c', message: 'need bulk  upload' });
        expect(dup.result.count).toBe(2);

        const res = fakeRes();
        await h.list({}, 2, res, true);
        expect(res.body.result.total).toBe(1);
        expect(res.body.result.items[0].count).toBe(2);
    });

    test('去重边界：不同 method 或不同 type 是独立条目', async () => {
        await submit(h, { type: 'missing_capability', method: 'a.b.c', message: 'need X' });
        await submit(h, { type: 'missing_capability', method: 'd.e.f', message: 'need X' });
        await submit(h, { type: 'bad_returns', method: 'a.b.c', message: 'need X' });
        const res = fakeRes();
        await h.list({}, 2, res, true);
        expect(res.body.result.total).toBe(3);
    });

    test('list: 非 admin 拒；type/status 过滤生效', async () => {
        await submit(h, { type: 'missing_capability', message: 'gap A' });
        await submit(h, { type: 'chain_failure', message: 'gap B' });

        const deny = fakeRes();
        await h.list({}, 2, deny, false);
        expect(deny.body.error.code).toBe(-32001);

        const byType = fakeRes();
        await h.list({ type: 'chain_failure' }, 3, byType, true);
        expect(byType.body.result.total).toBe(1);
        expect(byType.body.result.items[0].message).toBe('gap B');

        const byStatus = fakeRes();
        await h.list({ status: 'RESOLVED' }, 4, byStatus, true);
        expect(byStatus.body.result.total).toBe(0);
    });

    test('update: 标记状态 + FP 索引同步；再次提交同诉求仍能去重且保留新状态', async () => {
        const first = await submit(h, { type: 'missing_capability', method: 'a.b.c', message: 'need X' });
        const id = first.result.reportId;

        const upd = fakeRes();
        await h.update({ reportId: id, status: 'REVIEWED' }, 2, upd, true);
        expect(upd.body.result.updated).toBe(true);
        expect(upd.body.result.report.status).toBe('REVIEWED');

        // 同诉求再进来：count+1，状态保持 REVIEWED（去重走 FP 索引，证明索引已同步）
        const dup = await submit(h, { type: 'missing_capability', method: 'a.b.c', message: 'need X' });
        expect(dup.result.count).toBe(2);
        const res = fakeRes();
        await h.list({ status: 'REVIEWED' }, 3, res, true);
        expect(res.body.result.total).toBe(1);
        expect(res.body.result.items[0].count).toBe(2);
    });

    test('update: 非 admin 拒；非法状态拒；不存在的 id 报 -32002', async () => {
        const deny = fakeRes();
        await h.update({ reportId: 'x', status: 'REVIEWED' }, 2, deny, false);
        expect(deny.body.error.code).toBe(-32001);

        const bad = fakeRes();
        await h.update({ reportId: 'x', status: 'WHATEVER' }, 3, bad, true);
        expect(bad.body.error.code).toBe(-32602);

        const missing = fakeRes();
        await h.update({ reportId: 'nope', status: 'RESOLVED' }, 4, missing, true);
        expect(missing.body.error.code).toBe(-32002);
    });

    test('旧格式兼容：v1.1.11 前条目（无 count/status/fingerprint）读出补默认值', async () => {
        const legacy = JSON.stringify({
            id: 'legacy-1', type: 'other', method: null,
            message: 'old style', context: null, createdAt: '2026-06-01T00:00:00.000Z',
        });
        await redis.zAdd('SYSTEM:AI:REPORT', { score: 1, value: legacy });

        const res = fakeRes();
        await h.list({}, 2, res, true);
        const item = res.body.result.items.find(r => r.id === 'legacy-1');
        expect(item).toMatchObject({ count: 1, status: 'NEW', lastSeenAt: '2026-06-01T00:00:00.000Z' });
    });

    test('容量裁剪：超 1000 条裁最旧，且同步清掉 FP 索引', async () => {
        // 预灌 1000 条互不相同的条目（直接写存储，绕过 submit 加速）
        for (let i = 0; i < 1000; i++) {
            const r = { id: `r${i}`, fingerprint: `fp${i}`, type: 'other', message: `m${i}`, count: 1, status: 'NEW', createdAt: 'x', lastSeenAt: 'x' };
            const json = JSON.stringify(r);
            await redis.zAdd('SYSTEM:AI:REPORT', { score: i, value: json });
            await redis.hSet('SYSTEM:AI:REPORT:FP', `fp${i}`, json);
        }
        await submit(h, { type: 'other', message: 'the 1001st' });

        expect(await redis.zCard()).toBe(1000);
        // 最旧的 r0 被裁，且它的 FP 索引一并清掉
        expect(await redis.hGet('SYSTEM:AI:REPORT:FP', 'fp0')).toBeNull();
        // 新条目在
        const res = fakeRes();
        await h.list({ page: 1, pageSize: 5 }, 2, res, true);
        expect(res.body.result.items[0].message).toBe('the 1001st');
    });
});
