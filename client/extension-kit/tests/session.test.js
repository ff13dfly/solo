/**
 * session —— token 存哪一层、要不要留凭据。
 * 「记住」= local（关浏览器仍在）；不记住 = session（关浏览器即失效）。
 */
import { createSession } from '../lib/session.js';
import { memoryArea } from '../lib/storage.js';

const mk = () => {
    const local = memoryArea();
    const session = memoryArea();
    return { local, session, s: createSession({ local, session }) };
};

test('不记住：token 落 session，关浏览器（丢弃 session 区）即失效', async () => {
    const { local, session, s } = mk();
    await s.setToken('t1');
    expect(session._dump().token).toBe('t1');
    expect(local._dump().token).toBeUndefined();
    expect(await s.getToken()).toBe('t1');
});

test('记住：token 落 local，跨浏览器重启仍在', async () => {
    const { local, session, s } = mk();
    await s.setRemember(true);
    await s.setToken('t1');
    expect(local._dump().token).toBe('t1');
    expect(session._dump().token).toBeUndefined();
});

test('🔴 切换 remember 不留影子 token —— 否则下次读到过期的那个就是一次莫名 -32001', async () => {
    const { local, session, s } = mk();
    await s.setToken('old');                 // → session
    await s.setRemember(true);
    await s.setToken('new');                 // → local，且要清掉 session 里的 old
    expect(session._dump().token).toBeUndefined();
    expect(await s.getToken()).toBe('new');
});

test('关掉 remember 立刻清凭据与持久 token，不留残留', async () => {
    const { local, s } = mk();
    await s.setRemember(true);
    await s.setCredentials({ name: 'a', password: 'p' });
    await s.setToken('t');
    await s.setRemember(false);
    expect(local._dump().credentials).toBeUndefined();
    expect(local._dump().token).toBeUndefined();
});

test('凭据是不透明对象 —— 密码或设备令牌都放得下（passport 迁移不用改本文件）', async () => {
    const { s } = mk();
    await s.setCredentials({ anchor: 'dev-abc', deviceId: 'd1', deviceToken: 'tok' });
    expect(await s.getCredentials()).toEqual({ anchor: 'dev-abc', deviceId: 'd1', deviceToken: 'tok' });
    await s.setCredentials(null);
    expect(await s.getCredentials()).toBeUndefined();
});

test('logout 清 token 与凭据（两层都清）', async () => {
    const { local, session, s } = mk();
    await s.setRemember(true);
    await s.setToken('t'); await s.setCredentials({ name: 'a' });
    await s.logout();
    expect(await s.getToken()).toBeUndefined();
    expect(await s.getCredentials()).toBeUndefined();
    expect(session._dump().token).toBeUndefined();
    expect(local._dump().token).toBeUndefined();
});
