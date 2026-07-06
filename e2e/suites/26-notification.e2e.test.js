/**
 * 26 · notification 站内信 send → inbox.list → ack(不配 config,避免触发外部投递).
 * 自定义存储(NOTIFICATION:MSG + ZSET 索引 + INBOX zset)→ 断 ①API ②落库 + 无异常(无 entity WAL).
 */
const { rpc } = require('../lib/client');
const redisLib = require('../lib/redis');
const V = require('../lib/verify');
const { sessionUser, cleanupUser } = require('../harness/identity');

const PROFILE = (process.env.E2E_PROFILE || 'lite').toLowerCase();
const gate = PROFILE === 'full' ? describe : describe.skip;

gate('26 · notification send + inbox', () => {
    let redis, uid, token, msgId;
    const name = `e2e-notif-${process.pid}`;
    const target = `e2e-tgt-${process.pid}`;

    beforeAll(async () => {
        redis = await redisLib.connect();
        ({ uid, token } = await sessionUser(redis, name, { notification: ['*'] }));
    }, 20_000);
    afterAll(async () => {
        if (msgId) { await redis.del(`NOTIFICATION:MSG:${msgId}`); await redis.zRem('NOTIFICATION:INDEX', msgId); }
        await redis.del(`NOTIFICATION:INBOX:${target}`);
        await cleanupUser(redis, { uid, name });
        await redis.quit();
    });

    test('send → ①API ②落库(MSG + ZSET 索引 + inbox)', async () => {
        const r = V.assertResult(await rpc('notification.send', { targetId: target, type: 'e2e.note', payload: { hello: 'world' }, ref: `r-${process.pid}` }, token), 'send');
        msgId = r.id || r.messageId || r.msgId;
        expect(msgId).toBeTruthy();

        await V.assertRecord(redis, `NOTIFICATION:MSG:${msgId}`, { targetId: target });   // ②
        expect(await redis.zScore('NOTIFICATION:INDEX', msgId)).not.toBeNull();           // ② 全局 zset 索引
        expect(await redis.zScore(`NOTIFICATION:INBOX:${target}`, msgId)).not.toBeNull(); // ② 收件箱 zset
        await V.assertNoErrors(redis, ['notification']);
    });

    test('inbox.list shows it (unread) → ack marks read', async () => {
        const list = V.assertResult(await rpc('notification.inbox.list', { targetId: target, unreadOnly: true }, token), 'inbox.list');
        expect(list.items.some((x) => x.id === msgId)).toBe(true);

        V.assertResult(await rpc('notification.inbox.ack', { ids: [msgId] }, token), 'ack');
        const rec = await V.readKey(redis, `NOTIFICATION:MSG:${msgId}`);
        expect(rec.status).toBe('read');
    });
});
