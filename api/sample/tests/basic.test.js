/**
 * basic.test.js — 合规冒烟:服务静态结构是否自洽(config + introspection)。
 * 真正的逻辑测试见 item.test.js(hermetic,注入 fake redis,演示该照抄的测试方法)。
 *
 * 注意:这是 jest 测试(describe/test/expect),不是 process.exit 脚本 ——
 * process.exit 脚本进不了 `jest.ci.config.js` 白名单,也不该再写。
 */
const config = require('../config');
const introspection = require('../handlers/introspection');

describe('sample service compliance', () => {
    test('config 有 serviceName 与 port', () => {
        expect(config.serviceName).toBeTruthy();
        expect(config.port).toEqual(expect.any(Number));
    });

    test('introspection 是非空数组,每项都有 name', () => {
        expect(Array.isArray(introspection)).toBe(true);
        expect(introspection.length).toBeGreaterThan(0);
        for (const m of introspection) {
            expect(typeof m.name).toBe('string');
            expect(m.name.length).toBeGreaterThan(0);
        }
    });

    test('infra 方法 ping/methods/entities 已声明', () => {
        // introspection 声明 ↔ index.js 注册 的同步由 deploy/check-doc-drift.js 在 CI 守护;
        // 这里只兜个底:基础设施方法必须在自省表里。
        const names = new Set(introspection.map((m) => m.name));
        for (const infra of ['ping', 'methods', 'entities']) {
            expect(names.has(infra)).toBe(true);
        }
    });
});
