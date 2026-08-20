/**
 * endpoints —— 单一真源。锁的是那两条踩过的坑：
 *   · background 与 popup 必须取同一个值（wavely 的默认值漂移 → "登录成功但读不到数据"）
 *   · 不自动补尾斜杠（/rpc/ 与 /jsonrpc 的正确形态不同，猜一个必坏另一个）
 */
import { createEndpoints, normalize } from '../lib/endpoints.js';
import { memoryArea } from '../lib/storage.js';

const PRESETS = [
    { url: 'https://erp.example.com/rpc/', name: '线上测试' },
    { url: 'http://localhost:8440/jsonrpc', name: '本地全栈' },
];

test('空 presets 直接拒绝 —— [0] 就是装完不改设置就能用的默认值', () => {
    expect(() => createEndpoints({ backend: memoryArea(), presets: [] })).toThrow(/presets/);
});

test('默认取 presets[0]；set 之后取存下来的', async () => {
    const ep = createEndpoints({ backend: memoryArea(), presets: PRESETS });
    expect(await ep.get()).toBe(PRESETS[0].url);
    await ep.set('http://localhost:8440/jsonrpc');
    expect(await ep.get()).toBe('http://localhost:8440/jsonrpc');
});

test('🔴 两个消费者（background / popup）拿到的是同一个值', async () => {
    const backend = memoryArea();
    const bg = createEndpoints({ backend, presets: PRESETS });
    const popup = createEndpoints({ backend, presets: PRESETS });
    await popup.set('http://localhost:8440/jsonrpc');
    expect(await bg.get()).toBe(await popup.get());
});

test('🔴 尾斜杠原样保留，两种形态都不被改坏', async () => {
    expect(normalize('https://x/rpc/')).toBe('https://x/rpc/');
    expect(normalize('https://x/jsonrpc')).toBe('https://x/jsonrpc');
    expect(normalize('  https://x/rpc/  ')).toBe('https://x/rpc/');
});

test('非法地址当场抛，别等到发请求时才发现', () => {
    expect(() => normalize('')).toThrow(/不能为空/);
    expect(() => normalize('不是地址')).toThrow(/不是合法的地址/);
    expect(() => normalize('ftp://x/y')).toThrow(/http\/https/);
});

test('自定义地址：预置在前、自加在后，不重复', async () => {
    const ep = createEndpoints({ backend: memoryArea(), presets: PRESETS });
    await ep.add('http://10.0.0.9:8440/jsonrpc', '实验机');
    await ep.add('http://10.0.0.9:8440/jsonrpc', '实验机');       // 重复
    await ep.add('https://erp.example.com/rpc/', '已在预置里');    // 撞预置
    const list = await ep.list();
    expect(list.length).toBe(3);
    expect(list[2]).toEqual({ url: 'http://10.0.0.9:8440/jsonrpc', name: '实验机' });

    await ep.remove('http://10.0.0.9:8440/jsonrpc');
    expect((await ep.list()).length).toBe(2);
});
