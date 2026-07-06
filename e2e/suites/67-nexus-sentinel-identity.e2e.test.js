/**
 * 67 · §1.2 per-Sentinel identity —— "fetch 在该 Sentinel 自己的 bot permit 下运行"那条端到端.
 *
 * 手动发证流程（管理员侧，本测用 ADMIN_TOKEN 走完）:
 *   ① user.bot.create        —— 建一个 system.nexus.sentinel.<pid> bot，permit 只放 collection.payment.get
 *   ② user.bot.issue.token   —— 签发该 bot 的 token
 *   ③ nexus.sentinel.token.set —— 把 token 注入 nexus（authorityRole = 该 bot uid）
 *   ④ nexus.sentinel.create  —— authorityRole 指向该 bot；声明一个 collection.payment.get fetcher
 * 然后注入事件，断言装配后的 payload 里 fetch 真拉到了 payment ——
 * 证明 fetch 是经 relay.callAs 以**该 Sentinel 自己的窄身份**发起、被 Router 放行的.
 *
 * 另测**配置时预审闸**:声明一个不在 bot permit 内的 fetcher（collection.payment.list）→ create 被拒（-32602）.
 *
 * 只在 full profile 跑（需 user + nexus + collection + notification + router 全栈 + nexus 消费者开）.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STREAM = 'EVENT:WORKFLOW:STATUS';
const TAG = `id-${process.pid}`;
const BOT_UID = `system.nexus.sentinel.e2e${process.pid}`;
const TOKEN_KEY = `NEXUS:SENTINEL:TOKEN:${BOT_UID}`;

gate('67 · nexus per-Sentinel identity (scoped data_fetchers + pre-audit)', () => {
    let redis;
    let sentinelId;
    let paymentId;

    beforeAll(async () => {
        redis = await redisLib.connect();

        // ① bot with a NARROW permit — only collection.payment.get (NOT .list / .record).
        //    Plus the Sentinel-bot infra methods: user.permit.get (so config-time
        //    pre-audit can self-read this permit) + user.token.refresh (token rotation).
        V.assertResult(await rpc('user.bot.create', {
            uid: BOT_UID,
            permit: { allow_all: false, services: {
                collection: ['collection.payment.get'],
                user: ['user.permit.get', 'user.token.refresh'],
                agent: ['agent.decide'], // write-side: autorun runs agent.decide under THIS bot (pre-audited)
            } },
            desc: 'e2e §1.2 scoped sentinel bot',
        }, ADMIN_TOKEN), 'bot.create');

        // ② issue its token, ③ inject into nexus keyed by authorityRole
        const tok = V.assertResult(await rpc('user.bot.issue.token', { uid: BOT_UID }, ADMIN_TOKEN), 'bot.issue.token');
        V.assertResult(await rpc('nexus.sentinel.token.set', {
            authorityRole: BOT_UID, token: tok.token, expiresAt: tok.expiresAt,
        }, ADMIN_TOKEN), 'sentinel.token.set');
    }, 30_000);

    afterAll(async () => {
        if (sentinelId) {
            await redis.del(`NEXUS:SENTINEL:${sentinelId}`);
            await redis.sRem('NEXUS:SENTINEL:SET', sentinelId);
            await redis.sRem(`NEXUS:SUB:${STREAM}`, sentinelId);
            await redis.del(`NEXUS:SENTINEL:ONLINE:${sentinelId}`);
            const ids = await redis.zRange(`NOTIFICATION:INBOX:${sentinelId}`, 0, -1);
            for (const id of ids) await redis.del(`NOTIFICATION:MSG:${id}`);
            await redis.del(`NOTIFICATION:INBOX:${sentinelId}`);
        }
        if (paymentId) {
            await redis.del(`COLLECTION:PAYMENT:${paymentId}`);
            await redis.sRem('COLLECTION:PAYMENT:INDEX', paymentId);
        }
        await redis.del(TOKEN_KEY);
        // revoke live session + delete the bot (revoke needs admin; nexus bot can't)
        await rpc('user.token.revoke', { uid: BOT_UID }, ADMIN_TOKEN).catch(() => {});
        await rpc('user.bot.delete', { uid: BOT_UID }, ADMIN_TOKEN).catch(() => {});
        await redis.quit();
    });

    // ── 配置时预审闸:声明的 fetcher 方法不在 bot permit 内 → create 拒 ────────────
    test('create with a fetcher outside the bot permit → rejected by pre-audit (-32602)', async () => {
        const res = await rpc('nexus.sentinel.create', {
            name: `e2e-id-bad-${process.pid}`,
            authorityRole: BOT_UID,
            eventSubscriptions: [STREAM],
            reachability: 'polling',
            context: {
                // collection.payment.list is NOT in the bot's permit (only .get is)
                data_fetchers: [{ key: 'p', method: 'collection.payment.list', params: {} }],
            },
        }, ADMIN_TOKEN);
        expect(res.error).toBeTruthy();
        expect(res.error.code).toBe(-32602);
        expect(String(res.error.message)).toMatch(/permit|allow/i);
    }, 30_000);

    // ── 端到端:fetch 经该 Sentinel 自己的窄 token 拉到数据 ────────────────────────
    test('event → fetch under the Sentinel\'s OWN scoped token → enriched payload in inbox', async () => {
        const p = V.assertResult(await rpc('collection.payment.record', {
            amount: 777, currency: 'CNY', orderId: `id-${process.pid}`,
        }, ADMIN_TOKEN), 'payment.record');
        paymentId = p.id;

        // fetcher targets collection.payment.get — exactly what the bot permit allows → pre-audit passes
        const a = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-id-agent-${process.pid}`,
            authorityRole: BOT_UID,
            eventSubscriptions: [STREAM],
            reachability: 'polling',
            context: {
                guard: { '==': [{ var: 'event.tag' }, TAG] },
                data_fetchers: [
                    { key: 'payment', method: 'collection.payment.get', params: { id: '{{event.paymentId}}' } },
                ],
                system_prompt_template: '付款 {{event.paymentId}} = {{fetch.payment.amount}}',
                autorun: true, // write-side: run agent.decide under this Sentinel's own token
            },
        }, ADMIN_TOKEN), 'sentinel.create');
        sentinelId = a.id;
        expect(await redis.sIsMember(`NEXUS:SUB:${STREAM}`, sentinelId)).toBeTruthy();

        await sleep(800);
        await redis.xAdd(STREAM, '*', { tag: TAG, paymentId, kind: 'e2e' });

        let msg = null;
        for (let i = 0; i < 50; i++) {
            await sleep(500);
            const r = await rpc('notification.inbox.list', { targetId: sentinelId, unreadOnly: false }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            msg = items.find((m) => m.payload && m.payload.context && m.payload.context.data && m.payload.context.data.payment);
            if (msg) break;
        }
        expect(msg).toBeTruthy();
        // The fetch succeeded THROUGH the Router under the Sentinel's own narrow bot token.
        expect(msg.payload.context.data.payment.amount).toBe(777);
        expect(msg.payload.context.system_prompt).toContain('777');
        expect(msg.payload.context.sentinel.id).toBe(sentinelId);
        // Write-side: autorun's agent.decide also ran under THIS bot's token (permit grants
        // agent.decide) — no FORBIDDEN, so no autorun_error, and the structured decision is present.
        expect(msg.payload.context.autorun_error).toBeUndefined();
        expect(msg.payload.context.output).toBeTruthy();
        expect(typeof msg.payload.context.output.decision).toBe('string');

        // Activity ledger (G1 visibility): the consumer recorded this delivery, and
        // sentinel.get surfaces it — the portal's "did it ever react?" column.
        const got = V.assertResult(await rpc('nexus.sentinel.get', { id: sentinelId }, ADMIN_TOKEN), 'sentinel.get');
        expect(got.activity).toBeTruthy();
        expect(got.activity.fired).toBeGreaterThanOrEqual(1);
        expect(got.activity.lastFiredAt).toBeGreaterThan(0);
        // identity is expiry-aware (G3): token was just injected → present, not expired.
        expect(got.identity).toMatchObject({ mode: 'bot', uid: BOT_UID, hasToken: true, expired: false });
    }, 60_000);

    // ── 安全性质:token 缺失 → 装配中止(绝不回退共享身份)→ 注入 token 后同一条 pending 恢复投递 ──
    // 这是 §1.2 的反向承诺:"a missing/expired token aborts assembly … rather than silently
    // falling back to the broad nexus permit"(context.js)。中止必须可见(NEXUS:RETRY:*),
    // 且收件箱必须为空——证明 fetch 没有借 system.nexus 的宽身份偷跑。
    test('missing identity token → delivery ABORTS (no fallback) → provisioning recovers the same entry', async () => {
        const BOT2 = `${BOT_UID}b`;
        const TAG2 = `${TAG}-notoken`;
        let sentinel2 = null;
        let payment2 = null;
        try {
            // bot 有窄 permit,但 token 故意不注入
            V.assertResult(await rpc('user.bot.create', {
                uid: BOT2,
                permit: { allow_all: false, services: {
                    collection: ['collection.payment.get'],
                    user: ['user.permit.get', 'user.token.refresh'],
                } },
                desc: 'e2e §1.2 token-less sentinel bot',
            }, ADMIN_TOKEN), 'bot2.create');

            const p2 = V.assertResult(await rpc('collection.payment.record', {
                amount: 888, currency: 'CNY', orderId: `id-notoken-${process.pid}`,
            }, ADMIN_TOKEN), 'payment2.record');
            payment2 = p2.id;

            // create 放行:预审刻意在 token 未供给时跳过(运行期由 Router 兜底)
            const s = V.assertResult(await rpc('nexus.sentinel.create', {
                name: `e2e-id-notoken-${process.pid}`,
                authorityRole: BOT2,
                eventSubscriptions: [STREAM],
                reachability: 'polling',
                context: {
                    guard: { '==': [{ var: 'event.tag' }, TAG2] },
                    data_fetchers: [{ key: 'payment', method: 'collection.payment.get', params: { id: '{{event.paymentId}}' } }],
                },
            }, ADMIN_TOKEN), 'sentinel2.create');
            sentinel2 = s.id;

            await sleep(800);
            const entryId = await redis.xAdd(STREAM, '*', { tag: TAG2, paymentId: payment2, kind: 'e2e-notoken' });

            // ① 中止可见:settle 走了 retry 分支(没有 ack、没有投递)
            const retryKey = `NEXUS:RETRY:${STREAM}:${entryId}`;
            let retried = null;
            for (let i = 0; i < 30 && !retried; i++) { await sleep(500); retried = await redis.get(retryKey); }
            expect(retried).toBeTruthy();

            // ② 没有任何投递落到收件箱——fetch 绝没有借共享 nexus 身份偷跑
            const inbox = await rpc('notification.inbox.list', { targetId: sentinel2, unreadOnly: false }, ADMIN_TOKEN);
            expect((((inbox.result || {}).items) || []).length).toBe(0);

            // ③ 注入 token → recoverPending 按退避重试同一条 pending → 投递完成且 fetch 拉到数据
            const tok2 = V.assertResult(await rpc('user.bot.issue.token', { uid: BOT2 }, ADMIN_TOKEN), 'bot2.issue.token');
            V.assertResult(await rpc('nexus.sentinel.token.set', {
                authorityRole: BOT2, token: tok2.token, expiresAt: tok2.expiresAt,
            }, ADMIN_TOKEN), 'sentinel2.token.set');

            let msg = null;
            for (let i = 0; i < 60 && !msg; i++) {
                await sleep(500);
                const r = await rpc('notification.inbox.list', { targetId: sentinel2, unreadOnly: false }, ADMIN_TOKEN);
                msg = ((((r.result || {}).items) || [])).find((m) => m.payload && m.payload.context && m.payload.context.data && m.payload.context.data.payment);
            }
            expect(msg).toBeTruthy();
            expect(msg.payload.context.data.payment.amount).toBe(888);   // 同一条 entry 在新身份下恢复
        } finally {
            if (sentinel2) {
                await redis.del(`NEXUS:SENTINEL:${sentinel2}`);
                await redis.sRem('NEXUS:SENTINEL:SET', sentinel2);
                await redis.sRem(`NEXUS:SUB:${STREAM}`, sentinel2);
                const ids = await redis.zRange(`NOTIFICATION:INBOX:${sentinel2}`, 0, -1);
                for (const id of ids) await redis.del(`NOTIFICATION:MSG:${id}`);
                await redis.del(`NOTIFICATION:INBOX:${sentinel2}`);
            }
            if (payment2) {
                await redis.del(`COLLECTION:PAYMENT:${payment2}`);
                await redis.sRem('COLLECTION:PAYMENT:INDEX', payment2);
            }
            await redis.del(`NEXUS:SENTINEL:TOKEN:${BOT2}`);
            await rpc('user.token.revoke', { uid: BOT2 }, ADMIN_TOKEN).catch(() => {});
            await rpc('user.bot.delete', { uid: BOT2 }, ADMIN_TOKEN).catch(() => {});
        }
    }, 90_000);
});
