/**
 * profile-lanes — 双通道契约：submit 是审核通道里的**创建**；enroll 把既有可信 profile
 * 事后纳入审核（追溯治理）。
 *
 * 背景（docs/feedback/fulfillment-profile-submit-contract-and-enroll-gap.md）：
 *   1. submit 撞已存在 id 时曾抛实体工厂的通用 "already exists"，把调用方引向
 *      「create 被重复调了」而不是「submit 本来就是创建」——现在换成指路的专用报错；
 *   2. 可信直建的 profile 此前**永远无法**事后纳入审核——现在 submit { id, enroll: true }
 *      （handler 层 admin 门）补上这条路：重 lint、置 PENDING_REVIEW、实例随激活闸冻结。
 *
 * Needs a real Redis on 6379 (redis-stack in CI).
 */
const { createClient } = require('redis');
const createProfileLogic = require('../logic/profile');

const SERVICE = 'fulfillanes55';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// 最小 lint-clean 定义：离开 DRAFT、不引用任何外部方法/字段
const CLEAN = { transitions: [{ event: 'go', from: 'DRAFT', to: 'DONE' }] };
// lint 必炸的定义：task action 指向不存在的方法
const BROKEN = { transitions: [{ event: 'go', from: 'DRAFT', to: 'DONE', actions: [{ type: 'task', method: 'ghost.method.x' }] }] };

let redis;
let profile;

beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    profile = createProfileLogic(redis, { serviceName: SERVICE, idLengths: { profile: 8 } }, null);
});

async function clearService() {
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: `${SERVICE.toUpperCase()}:*`, COUNT: 500 })) {
        if (Array.isArray(k)) keys.push(...k); else keys.push(k);
    }
    if (keys.length) await redis.del(keys);
}

beforeEach(clearService);

afterAll(async () => {
    await clearService();
    await redis.quit();
});

describe('submit — creates in the review lane', () => {
    test('lint-clean submit lands in PENDING_REVIEW with submittedBy', async () => {
        const r = await profile.submit({ id: 'p1', name: 'p1', ...CLEAN }, { user: 'ext-1' });
        expect(r).toMatchObject({ ok: true, id: 'p1', reviewState: 'PENDING_REVIEW' });
        const stored = await profile.get({ id: 'p1' });
        expect(stored.submittedBy).toBe('ext-1');
    });

    test('colliding with an existing id gives the lane-aware error, not the generic "already exists"', async () => {
        await profile.create({ id: 'p1', name: 'p1', ...CLEAN });   // 可信直建
        await expect(profile.submit({ id: 'p1', name: 'p1', ...CLEAN }, { user: 'ext-1' }))
            .rejects.toMatchObject({
                code: -32602,
                message: expect.stringMatching(/CREATES a new profile in the review lane[\s\S]*enroll: true/),
            });
        // 报错要点名对方在哪条通道
        await expect(profile.submit({ id: 'p1', ...CLEAN }, {}))
            .rejects.toMatchObject({ message: expect.stringContaining('trusted direct-create') });
    });
});

describe('enroll — retroactive governance for trusted profiles', () => {
    test('flips a trusted profile to PENDING_REVIEW with enrolledBy (NOT submittedBy)', async () => {
        await profile.create({ id: 'p1', name: 'p1', ...CLEAN });
        const r = await profile.submit({ id: 'p1', enroll: true }, { user: 'admin-1' });
        expect(r).toMatchObject({ ok: true, id: 'p1', reviewState: 'PENDING_REVIEW' });
        const stored = await profile.get({ id: 'p1' });
        expect(stored.reviewState).toBe('PENDING_REVIEW');
        expect(stored.enrolledBy).toBe('admin-1');
        expect(stored.submittedBy).toBeUndefined();
        expect(stored.approvals).toEqual([]);
    });

    test('enrolling admin can approve afterwards (no submitter-equality deadlock in single-admin systems)', async () => {
        await profile.create({ id: 'p1', name: 'p1', ...CLEAN });
        await profile.submit({ id: 'p1', enroll: true }, { user: 'admin-1' });
        const approved = await profile.approve({ id: 'p1' }, { user: 'admin-1' });
        expect(approved.reviewState).toBe('APPROVED');
        expect(approved.approvedDigest).toBeTruthy();
    });

    test('profile already in the review lane cannot be enrolled again', async () => {
        await profile.submit({ id: 'p1', name: 'p1', ...CLEAN }, { user: 'ext-1' });
        await expect(profile.submit({ id: 'p1', enroll: true }, { user: 'admin-1' }))
            .rejects.toMatchObject({ code: -32005 });
    });

    test('missing profile → NOT_FOUND; missing id → MISSING_PARAM', async () => {
        await expect(profile.submit({ id: 'nope', enroll: true }, {})).rejects.toMatchObject({ code: -32002 });
        await expect(profile.submit({ enroll: true }, {})).rejects.toMatchObject({ code: -32602 });
    });

    test('lint-broken stored profile is refused at the gate and stays trusted/usable', async () => {
        await profile.create({ id: 'p1', name: 'p1', ...BROKEN });   // 直建不过 lint，本来就允许
        const r = await profile.submit({ id: 'p1', enroll: true }, { user: 'admin-1' });
        expect(r.ok).toBe(false);
        expect(r.lintReport.errors.length).toBeGreaterThan(0);
        const stored = await profile.get({ id: 'p1' });
        expect(stored.reviewState).toBeUndefined();   // 什么都没改
    });
});
