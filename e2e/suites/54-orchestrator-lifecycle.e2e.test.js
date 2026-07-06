/**
 * 54 · orchestrator lifecycle —— 覆盖 52/90/91 没碰过的 orchestrator 方法面.
 *
 * 52 只测了 create→approve(C1 闸门的 happy/self-approve);91 直接注入 ACTIVE 跑事件链.
 * 本套补齐其余生命周期 RPC,全部走 Router 真签名转发(无直调微服务):
 *   workflow:  deny / get / list / categories / update / delete / restore / build / snapshot
 *   run(sync): orchestrator.run + orchestrator.workflow.run(approve 一个 ACTIVE 后同步跑)
 *   run(mgmt): run.list / run.get / run.abort(注入一个 PAUSED run 实体来驱动 abort 状态机)
 *   category:  create / get / list / update / delete + item.add / item.update / item.remove
 *   token:     token.status(只读 admin —— 绝不碰 token.set/clear,那会掐断 91/92 的 bot)
 *
 * 关键事实(读 logic/*.js 核实):
 *   - workflow.create 的 category 是 OBJECT({name});workflow doc 是 RedisJSON(redis.json.get).
 *   - sync run 的 H6 footprint 预审会经 Router 拉 caller 真 permit,再校验覆盖每个 step.method.
 *     所以 sync-run 必须用"有 collection.payment.record 权限的真实用户"当 caller,
 *     不能用 ADMIN_TOKEN(uid=e2e-admin 既非 16 位 Base58 也非 bot → user.permit.get 报 Invalid ID).
 *   - sync run 不产生 run 实体(只有 worker 异步源会);故 run.list/get/abort 用注入的 RUN 文档测.
 *   - run.abort 仅允许 PAUSED_AWAITING_HUMAN → ABORTED(run.js:123),注入态必须是它.
 *   - category 走 library/category.js:落 ORCHESTRATOR:CONFIG:CATEGORY:{KEY}(纯 JSON,非 RedisJSON)
 *     + 索引 ORCHESTRATOR:CONFIG:CATEGORY_IDX;create 还会到 Router 预订全局键(SYSTEM:REGISTRY:CATEGORIES).
 *
 * 共享栈纪律:所有 workflow/run/category id/key 带 process.pid;afterAll 逐一清
 * (del 数据键 + sRem/hDel 索引)。token.set/clear 一概不碰,不污染 relay bot.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser, ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WF_KEY = (id) => `ORCHESTRATOR:WORKFLOW:${id}`;
const WF_INDEX = 'ORCHESTRATOR:WORKFLOW_INDEX';
const RUN_KEY = (id) => `ORCHESTRATOR:RUN:${id}`;
const RUN_INDEX = 'ORCHESTRATOR:RUN_INDEX';
const CAT_KEY = (key) => `ORCHESTRATOR:CONFIG:CATEGORY:${key.toUpperCase()}`;
const CAT_IDX = 'ORCHESTRATOR:CONFIG:CATEGORY_IDX';
const CAT_REGISTRY = 'SYSTEM:REGISTRY:CATEGORIES';   // Router 全局键预订(hash, field=KEY)

// 一个最小合法 step:用 caller permit 覆盖得到的 collection.payment.record.
const STEP = { id: 's1', service: 'collection', method: 'collection.payment.record', params: { amount: 1, currency: 'CNY' } };

gate('54 · orchestrator lifecycle (deny/get/list/update/run/category/token)', () => {
    let redis, creator, approver;
    const nameA = `e2e-orch54-creator-${process.pid}`;
    const nameB = `e2e-orch54-approver-${process.pid}`;
    const wfIds = new Set();      // 所有造出的 workflow id
    const runIds = new Set();     // 所有注入的 run id
    const catKeys = new Set();    // 所有造出的 category key(原始大小写无关,统一 upper 清理)

    // 帮手:creator 建一个 PENDING_REVIEW workflow,登记以便清理.
    async function createPending(suffix) {
        const wf = V.assertResult(await rpc('orchestrator.workflow.create', {
            category: { name: 'e2e-orch54' },
            name: `E2E orch54 wf ${suffix}`,
            desc: `lifecycle test ${suffix}`,
            steps: [STEP],
        }, creator.token), `create(${suffix})`);
        wfIds.add(wf.id);
        return wf;
    }

    beforeAll(async () => {
        redis = await redisLib.connect();
        // creator 需:orchestrator(建/改/跑)+ collection.payment.record(sync-run step 要它)
        //   + user.permit.get(sync-run 的 H6 footprint 预审会用 caller 自己的 token 经 Router 拉
        //     caller permit;runner 透传 caller 的 Authorization,故 caller 必须有此权限).
        creator = await sessionUser(redis, nameA, {
            orchestrator: ['*'],
            collection: ['collection.payment.record'],
            user: ['user.permit.get'],
        });
        // approver:换人 approve 过 C1 自审禁令;同样授权以便它也能 sync-run.
        approver = await sessionUser(redis, nameB, {
            orchestrator: ['*'],
            collection: ['collection.payment.record'],
            user: ['user.permit.get'],
        });
    }, 25_000);

    afterAll(async () => {
        for (const id of wfIds) { await redis.del(WF_KEY(id)); await redis.sRem(WF_INDEX, id); }
        for (const id of runIds) {
            await redis.del(RUN_KEY(id));
            await redis.del(`${RUN_KEY(id)}:GRANT`);
            await redis.sRem(RUN_INDEX, id);
        }
        for (const key of catKeys) {
            await redis.del(CAT_KEY(key));
            await redis.sRem(CAT_IDX, CAT_KEY(key));
            await redis.hDel(CAT_REGISTRY, key.toUpperCase());
        }
        await cleanupUser(redis, { uid: creator.uid, name: nameA });
        await cleanupUser(redis, { uid: approver.uid, name: nameB });
        // category.create 经 Router system.category.reserve(无 admin 凭证)→ -32603 落 ERROR:QUEUE
        // (已知框架 bug);本套件有意触发,afterAll 清掉,免得污染断言"队列空"的套件。
        for (const k of await redisLib.scanAll(redis, 'ERROR:QUEUE:*')) await redis.del(k);
        await redis.quit();
    });

    // ── workflow: deny(C1 拒签) ──────────────────────────────────────────────
    test('workflow.deny: PENDING_REVIEW → REJECTED', async () => {
        const wf = await createPending('deny');
        expect(wf.status).toBe('PENDING_REVIEW');

        const res = V.assertResult(
            await rpc('orchestrator.workflow.deny', { id: wf.id, reason: 'e2e deny' }, approver.token),
            'deny',
        );
        expect(res.success).toBe(true);
        const doc = await redis.json.get(WF_KEY(wf.id));
        expect(doc.status).toBe('REJECTED');
        expect(doc.denialReason).toBe('e2e deny');
    }, 30_000);

    // ── workflow: get / list / categories ────────────────────────────────────
    test('workflow.get: 按 id 读回 + 字段形状', async () => {
        const wf = await createPending('get');
        const got = V.assertResult(await rpc('orchestrator.workflow.get', { id: wf.id }, creator.token), 'get');
        expect(got.id).toBe(wf.id);
        expect(got.status).toBe('PENDING_REVIEW');
        expect(Array.isArray(got.steps)).toBe(true);
        expect(got.steps[0].method).toBe('collection.payment.record');
    }, 30_000);

    test('workflow.list: { items,total } 含本套件造的 workflow', async () => {
        const wf = await createPending('list');
        const res = V.assertResult(await rpc('orchestrator.workflow.list', {}, creator.token), 'list');
        expect(Array.isArray(res.items)).toBe(true);
        expect(typeof res.total).toBe('number');
        const ids = new Set(res.items.map((w) => w.id));
        expect(ids.has(wf.id)).toBe(true);
    }, 30_000);

    test('workflow.categories: 返回数组(ACTIVE 工作流的 category 去重)', async () => {
        const cats = V.assertResult(await rpc('orchestrator.workflow.categories', {}, creator.token), 'categories');
        expect(Array.isArray(cats)).toBe(true);
    }, 30_000);

    // ── workflow: update(改 name/desc 等可编辑字段)──────────────────────────
    // 注:此前 update() 漏把 allowed_triggers destructure 进入参,引用即 ReferenceError →
    //     任何 update 都 100% 坏(本套件最初发现)。已修(workflow.js:225 加入 allowed_triggers)。
    test('workflow.update: 改 name/desc → 落库生效', async () => {
        const wf = await createPending('update');
        V.assertResult(await rpc('orchestrator.workflow.update', {
            id: wf.id,
            name: 'E2E orch54 wf update(renamed)',
            desc: 'updated desc',
        }, creator.token), 'workflow.update');
        const doc = await redis.json.get(WF_KEY(wf.id));
        expect(doc.name).toBe('E2E orch54 wf update(renamed)');   // 落库核实改动生效
        expect(doc.desc).toBe('updated desc');
    }, 30_000);

    // ── workflow: delete / restore(软删 → 恢复回 PENDING_REVIEW) ──────────────
    test('workflow.delete → DELETED, then restore → PENDING_REVIEW (C5)', async () => {
        const wf = await createPending('delrestore');

        const del = V.assertResult(await rpc('orchestrator.workflow.delete', { id: wf.id }, creator.token), 'delete');
        expect(del.success).toBe(true);
        expect((await redis.json.get(WF_KEY(wf.id))).status).toBe('DELETED');

        const res = V.assertResult(await rpc('orchestrator.workflow.restore', { id: wf.id }, creator.token), 'restore');
        expect(res.success).toBe(true);
        // C5:restore 永远回 PENDING_REVIEW(绝不直接 ACTIVE,不绕过审批闸).
        expect((await redis.json.get(WF_KEY(wf.id))).status).toBe('PENDING_REVIEW');
    }, 30_000);

    // ── workflow: build / snapshot(无参,写/读 AI 快照) ───────────────────────
    test('workflow.build → snapshot: build 写快照,snapshot 读回 items', async () => {
        const built = V.assertResult(await rpc('orchestrator.workflow.build', {}, creator.token), 'build');
        expect(built.success).toBe(true);
        expect(typeof built.count).toBe('number');

        // §3.4: external (non-admin) snapshot is trimmed to ACTIVE only; read it as ADMIN
        // to see the full set that build() reported (ACTIVE + PENDING_REVIEW).
        const snap = V.assertResult(await rpc('orchestrator.workflow.snapshot', {}, ADMIN_TOKEN), 'snapshot');
        expect(Array.isArray(snap.items)).toBe(true);
        // build 后的快照条数应与 build 报告的一致.
        expect(snap.items.length).toBe(built.count);
    }, 30_000);

    // ── run(sync): approve 一个 → ACTIVE → orchestrator.run / workflow.run ────
    test('orchestrator.run + workflow.run: 同步跑一个 ACTIVE workflow', async () => {
        const wf = await createPending('run');
        // §3.1: STEP uses collection.payment.record (a WRITE → HIGH risk → multi-sig lane).
        // This test is about "an ACTIVE workflow runs", not approval, so seed ACTIVE directly
        // (HIGH multi-sig approval is covered end-to-end in suite 110).
        const doc = await redis.json.get(WF_KEY(wf.id));
        await redis.json.set(WF_KEY(wf.id), '$', { ...doc, status: 'ACTIVE', effective_at: null });
        expect((await redis.json.get(WF_KEY(wf.id))).status).toBe('ACTIVE');

        // orchestrator.run(短别名):caller 有 collection.payment.record → 过 H6 → step 执行.
        const r1 = V.assertResult(await rpc('orchestrator.run', { workflowId: wf.id, input: {} }, creator.token), 'orchestrator.run');
        expect(r1.workflowId).toBe(wf.id);
        expect(r1.status).toBe('completed');
        expect(Array.isArray(r1.trace)).toBe(true);
        expect(r1.trace[0].status).toBe('success');

        // workflow.run(长名,同一执行引擎)亦可跑.
        const r2 = V.assertResult(await rpc('orchestrator.workflow.run', { workflowId: wf.id, input: {} }, creator.token), 'workflow.run');
        expect(r2.status).toBe('completed');

        // 副作用:step 真的 record 了 payment(清掉两笔,避免污染).
        for (const t of [...(r1.trace || []), ...(r2.trace || [])]) {
            const pid = t.result?.id;
            if (pid) { await redis.del(`COLLECTION:PAYMENT:${pid}`); await redis.sRem('COLLECTION:PAYMENT:INDEX', pid); }
        }
    }, 40_000);

    test('orchestrator.run on non-ACTIVE workflow → forbidden (C2)', async () => {
        const wf = await createPending('run-guard');   // PENDING_REVIEW
        const res = await rpc('orchestrator.run', { workflowId: wf.id, input: {} }, creator.token);
        const err = V.assertRpcError(res, undefined, 'run a PENDING workflow must be forbidden');
        expect(err.code).not.toBe(-32601);   // 可达,被 C2 闸挡(非 method-not-found)
    }, 30_000);

    // ── run(mgmt): list / get / abort(注入一个 PAUSED run 实体驱动状态机) ─────
    test('run.list / run.get / run.abort: 注入 PAUSED run → abort → ABORTED', async () => {
        const runId = `run-e2e-orch54-${process.pid}`;
        const now = Date.now();
        // 注入一个 PAUSED_AWAITING_HUMAN run 文档(abort 状态机唯一合法入边).
        await redis.json.set(RUN_KEY(runId), '$', {
            id: runId,
            workflowId: `wf-fake-${process.pid}`,
            input: {},
            triggerSource: 'event',
            triggerId: null,
            enqueuedAt: now,
            attempts: 0,
            status: 'PAUSED_AWAITING_HUMAN',
            missingMethods: ['collection.payment.settle'],
            startedAt: now,
            pausedAt: now,
        });
        await redis.sAdd(RUN_INDEX, runId);
        runIds.add(runId);

        // run.list(admin only):本注入的 run 应在内.
        const list = V.assertResult(await rpc('orchestrator.run.list', {}, ADMIN_TOKEN), 'run.list');
        expect(Array.isArray(list)).toBe(true);
        expect(list.some((r) => r.id === runId)).toBe(true);

        // run.list 带 status 过滤.
        const paused = V.assertResult(await rpc('orchestrator.run.list', { status: 'PAUSED_AWAITING_HUMAN' }, ADMIN_TOKEN), 'run.list(status)');
        expect(paused.every((r) => r.status === 'PAUSED_AWAITING_HUMAN')).toBe(true);
        expect(paused.some((r) => r.id === runId)).toBe(true);

        // run.get(admin only):按 id 读回.
        const got = V.assertResult(await rpc('orchestrator.run.get', { id: runId }, ADMIN_TOKEN), 'run.get');
        expect(got.id).toBe(runId);
        expect(got.status).toBe('PAUSED_AWAITING_HUMAN');

        // run.abort(admin only):PAUSED → ABORTED.
        const aborted = V.assertResult(await rpc('orchestrator.run.abort', { id: runId, reason: 'e2e abort' }, ADMIN_TOKEN), 'run.abort');
        expect(aborted.status).toBe('ABORTED');
        expect(aborted.abortReason).toBe('e2e abort');
        expect((await redis.json.get(RUN_KEY(runId))).status).toBe('ABORTED');
    }, 30_000);

    test('run.list / run.get require admin (non-admin → unauthorized)', async () => {
        const res = await rpc('orchestrator.run.list', {}, creator.token);
        const err = V.assertRpcError(res, undefined, 'run.list by non-admin must be unauthorized');
        expect(err.code).not.toBe(-32601);   // 可达,被 admin 闸挡
    }, 30_000);

    // ── category: get / list / update + item add/update/remove ────────────────
    //
    // orchestrator.category.create 走 library/category.js,内部再向 Router 发
    // system.category.reserve(联邦注册)。该 Router 方法对非 admin 调用要求 loopback
    // (router/handlers/auth.js isLoopbackRequest + router/index.js 闸):内部 RPC 来自本机
    // orchestrator → loopback 放行 → reserve 成功 → create 端到端成功(单节点联邦共享语义)。
    // ① 断 create 成功并落库;② 其余 get/list/update/item.* 纯本地 Redis(不碰 Router),注入 doc 覆盖。
    test('category.create succeeds (internal reserve permitted as a loopback call)', async () => {
        const key = `E2ELCREATE${process.pid}`;
        catKeys.add(key);
        const created = V.assertResult(await rpc('orchestrator.category.create', {
            key, type: 'LIST', scope: 'LOCAL', desc: 'e2e create reachability',
        }, ADMIN_TOKEN), 'category.create');
        expect(created.key).toBe(key.toUpperCase());       // 可达且成功(非 method-not-found / 非 Admin-required)
        expect(created.type).toBe('LIST');
        expect(created.status).toBe('ACTIVE');
        expect(await redis.get(CAT_KEY(key))).toBeTruthy(); // 落库(本地 Redis)
    }, 30_000);

    test('category.get/list/update + item.add/update/remove (local-only methods)', async () => {
        const key = `E2ELC${process.pid}`;
        catKeys.add(key);
        const now = Date.now();
        // 直接注入本地 category doc(绕过 Router 预订;这些方法只读写本地 Redis).
        await redis.set(CAT_KEY(key), JSON.stringify({
            key: key.toUpperCase(), type: 'LIST', scope: 'LOCAL',
            desc: 'e2e injected category', meta: {}, items: [],
            status: 'ACTIVE', createdAt: now, updatedAt: now,
        }));
        await redis.sAdd(CAT_IDX, CAT_KEY(key));

        // get.
        const got = V.assertResult(await rpc('orchestrator.category.get', { key }, ADMIN_TOKEN), 'category.get');
        expect(got.key).toBe(key.toUpperCase());
        expect(Array.isArray(got.items)).toBe(true);

        // list(本服务全部 category;本套件注入的应在内).
        const list = V.assertResult(await rpc('orchestrator.category.list', {}, ADMIN_TOKEN), 'category.list');
        expect(Array.isArray(list)).toBe(true);
        expect(list.some((c) => c.key === key.toUpperCase())).toBe(true);

        // update(desc).
        const upd = V.assertResult(await rpc('orchestrator.category.update', { key, desc: 'updated desc' }, ADMIN_TOKEN), 'category.update');
        expect(upd.desc).toBe('updated desc');

        // item.add.
        const itemId = `it-${process.pid}`;
        const added = V.assertResult(await rpc('orchestrator.category.item.add', {
            key, id: itemId, label: { zh: '项', en: 'Item' }, desc: 'item desc',
        }, ADMIN_TOKEN), 'category.item.add');
        expect(added.id).toBe(itemId);

        // item.update.
        const itemUpd = V.assertResult(await rpc('orchestrator.category.item.update', {
            key, id: itemId, desc: 'item desc updated',
        }, ADMIN_TOKEN), 'category.item.update');
        expect(itemUpd.desc).toBe('item desc updated');

        // 落库校验:item 在 doc.items 内.
        const docAfterAdd = JSON.parse(await redis.get(CAT_KEY(key)));
        expect(docAfterAdd.items.some((i) => i.id === itemId)).toBe(true);

        // item.remove.
        const rm = V.assertResult(await rpc('orchestrator.category.item.remove', { key, id: itemId }, ADMIN_TOKEN), 'category.item.remove');
        expect(rm.success).toBe(true);
        const docAfterRm = JSON.parse(await redis.get(CAT_KEY(key)));
        expect(docAfterRm.items.some((i) => i.id === itemId)).toBe(false);
    }, 40_000);

    // ── token.status(只读 admin —— 绝不触碰 set/clear) ───────────────────────
    test('token.status: 只读返回 relay token 状态(admin)', async () => {
        const status = V.assertResult(await rpc('orchestrator.token.status', {}, ADMIN_TOKEN), 'token.status');
        expect(typeof status.hasToken).toBe('boolean');
        // full profile 下 harness 已为 system.orchestrator 播过 token → 应有 token.
        expect(status.hasToken).toBe(true);
    }, 30_000);

    test('token.status requires admin (non-admin → unauthorized)', async () => {
        const res = await rpc('orchestrator.token.status', {}, creator.token);
        const err = V.assertRpcError(res, undefined, 'token.status by non-admin must be unauthorized');
        expect(err.code).not.toBe(-32601);
    }, 30_000);
});
