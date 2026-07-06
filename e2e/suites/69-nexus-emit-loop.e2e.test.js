/**
 * 68 · nexus emit-event 动作闭环（§2.2）—— "Sentinel 真去做事"那条端到端.
 *
 * 证明完整闭环(不是 inbox 死胡同):
 *   触发事件 → Sentinel A 被唤醒(guard)→ 装配 + autorun(**agent.decide** mock,结构化决策)
 *           → **context.emit** 用决策输出渲染并经真实 Router `event.emit` 把一条决策事件发上总线
 *           → 总线 → 订阅该决策流的 Sentinel B 收到它(nexus 消费 → notification inbox).
 * A 的**LLM 决策**自动驱动了一个新事件,B 真的对它做出反应 —— 这就是动作闭环.
 *
 * 关键点:
 *   - decision 由 agent.decide 产出(mock 选 choices[0]='review'),payload 从 {{output.decision}} 填,
 *     **不是硬编码** —— 这才是"决策真的驱动了 emit".
 *   - degradability:emit_when 只在 output.escalate==false(高置信)时放行,低置信/失败则不自动动作.
 *   - inverted gate:A 的 emit.stream/type + autorun.choices 在 create 时写死,模型只选/填值.
 *   - emit 经共享 system.nexus 身份发(registry fixture 放行 EVENT:E2E:*),actor=sentinel:{A}.
 *   - 幂等:同一 (ref, sentinel) 只发一次(stream.js SETNX 守卫),重投不会重复触发.
 *
 * 仅 full profile(需 nexus 消费者 + agent mock + Router event.emit + registry fixture).
 * 时序:先建 B(在决策流上从 '$' 建消费组)→ 再建 A → xAdd 触发 → 轮询 B 的 inbox.
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { ADMIN_TOKEN } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = process.pid;
const TAG = `emit-${PID}`;
const TRIGGER = `EVENT:E2E:TRIGGER:${PID}`;   // A 订阅;我们 xAdd 注入
const DECISION = `EVENT:E2E:DECISION:${PID}`; // A 发往;B 订阅(EVENT:E2E:* 在 fixture registry 内)

gate('68 · nexus emit-event action loop (autorun → context.emit → bus → another Sentinel)', () => {
    let redis;
    let aId;   // emitter Sentinel
    let bId;   // consumer Sentinel

    beforeAll(async () => { redis = await redisLib.connect(); }, 20_000);

    afterAll(async () => {
        for (const id of [aId, bId]) {
            if (!id) continue;
            await redis.del(`NEXUS:SENTINEL:${id}`);
            await redis.sRem('NEXUS:SENTINEL:SET', id);
            await redis.sRem(`NEXUS:SUB:${TRIGGER}`, id);
            await redis.sRem(`NEXUS:SUB:${DECISION}`, id);
            await redis.del(`NEXUS:SENTINEL:ONLINE:${id}`);
            const ids = await redis.zRange(`NOTIFICATION:INBOX:${id}`, 0, -1);
            for (const m of ids) await redis.del(`NOTIFICATION:MSG:${m}`);
            await redis.del(`NOTIFICATION:INBOX:${id}`);
        }
        await redis.del(TRIGGER);
        await redis.del(DECISION);
        await redis.quit();
    });

    test('emit fires and a downstream Sentinel reacts to the decision event', async () => {
        // 1. Consumer B FIRST — subscribing establishes the DECISION consumer group from
        //    '$', so A's later emit is captured (no subscribe→emit race).
        const b = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-emit-consumer-${PID}`,
            authorityRole: 'e2e:emit-consumer',
            eventSubscriptions: [DECISION],
            reachability: 'polling',
        }, ADMIN_TOKEN), 'sentinel.create(B)');
        bId = b.id;
        expect(await redis.sIsMember(`NEXUS:SUB:${DECISION}`, bId)).toBeTruthy();

        // 2. Emitter A — wakes on the tagged trigger, autoruns the (mock) LLM, then emits
        //    a fixed decision (stream/type fixed; payload filled from the event/sentinel).
        const a = V.assertResult(await rpc('nexus.sentinel.create', {
            name: `e2e-emit-emitter-${PID}`,
            authorityRole: 'e2e:emit-emitter',
            eventSubscriptions: [TRIGGER],
            reachability: 'polling',
            context: {
                guard: { '==': [{ var: 'event.tag' }, TAG] },
                // a rendered prompt is required for autorun to run; it becomes the decide instruction.
                system_prompt_template: '付款 {{event.paymentId}} 触发,请决策是否复核。',
                // autorun → agent.decide: mock picks choices[0]='review' (confidence 0.9, escalate false).
                autorun: { choices: ['review', 'approve'] },
                emit: {
                    stream: DECISION,
                    type: 'REVIEW',
                    // degradability: only emit a CONFIDENT (non-escalated) decision.
                    emit_when: { '==': [{ var: 'output.escalate' }, false] },
                    // payload VALUES come from the DECISION output — the model drove this, not a hardcode.
                    payload_template: {
                        decision: '{{output.decision}}',
                        confidence: '{{output.confidence}}',
                        paymentId: '{{event.paymentId}}',
                        by: '{{sentinel.id}}',
                    },
                },
            },
        }, ADMIN_TOKEN), 'sentinel.create(A)');
        aId = a.id;
        expect(await redis.sIsMember(`NEXUS:SUB:${TRIGGER}`, aId)).toBeTruthy();

        await sleep(900); // let both subscription sets be visible to the consumer

        // 3. Inject the trigger event.
        const paymentId = `pay-${PID}`;
        await redis.xAdd(TRIGGER, '*', { tag: TAG, paymentId, kind: 'e2e' });

        // 4. The decision must (a) land on the bus and (b) reach consumer B's inbox.
        let msg = null;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            const r = await rpc('notification.inbox.list', { targetId: bId, unreadOnly: false }, ADMIN_TOKEN);
            const items = (r.result && r.result.items) || [];
            msg = items.find((m) => m.payload && m.payload.type === 'REVIEW'
                && m.payload.payload && m.payload.payload.paymentId === paymentId);
            if (msg) break;
        }
        expect(msg).toBeTruthy();

        // The decision event A emitted, as B received it off the bus:
        expect(msg.payload.type).toBe('REVIEW');
        expect(msg.payload.payload.decision).toBe('review');       // from {{output.decision}} (agent.decide picked choices[0])
        expect(Number(msg.payload.payload.confidence)).toBeCloseTo(0.9); // from {{output.confidence}}
        expect(msg.payload.payload.paymentId).toBe(paymentId);
        expect(msg.payload.payload.by).toBe(aId);           // payload_template {{sentinel.id}}
        expect(msg.payload.actor).toBe(`sentinel:${aId}`);  // provenance attributed to A
        expect(msg.payload.source).toBe('system.nexus');    // emitted under the nexus bot

        // (b) the decision event is really on the bus, not just an inbox artifact.
        expect(await redis.xLen(DECISION)).toBeGreaterThanOrEqual(1);
    }, 90_000);
});
