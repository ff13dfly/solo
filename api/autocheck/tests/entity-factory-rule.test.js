/**
 * autocheck/static/entity-factory.js — 豁免标记的回归测试。Hermetic: 把一个最小
 * service 树写进 os.tmpdir()，直接调规则模块，不起 Redis、不跑 checker 全流程。
 *
 * 为什么这条规则值得单独钉：它是**唯一**决定「不用 Entity Factory 算不算 ERROR」的地方，
 * 而两个豁免标记语义不同、不可互换——singleton 说的是「没有 id、永远只有一份」，
 * external-store 说的是「行不在 Redis 里」。把 external-store 弄丢，症状不是报错，
 * 是下游项目被迫改函数名绕过门禁，那之后这件事在代码里就再没有痕迹了。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const rule = require('../static/entity-factory');

/** 在 tmpdir 里造一个 {apps|core}/<svc>/logic/<file> 的最小服务树，返回 servicePath */
function makeService({ layer = 'apps', logicSource }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-ef-rule-'));
    const svc = path.join(root, 'api', layer, 'catalog');
    fs.mkdirSync(path.join(svc, 'logic'), { recursive: true });
    fs.writeFileSync(path.join(svc, 'logic', 'product.js'), logicSource);
    return svc;
}

function run(servicePath) {
    const results = { passed: [], warnings: [], errors: [] };
    rule.check(servicePath, results);
    return results;
}

// 一个不碰 Redis、不 import entity.js 的 CRUD 实现 —— 规则的启发式判据正是命中这个形状
const EXTERNAL_STORE_LOGIC = `
const { pool } = require('../db');
async function create(req, data) {
    const { rows } = await pool.query('INSERT INTO product (name) VALUES ($1) RETURNING *', [data.name]);
    return rows[0];
}
async function update(req, id, data) {
    const { rows } = await pool.query('UPDATE product SET name=$1 WHERE id=$2 RETURNING *', [data.name, id]);
    return rows[0];
}
module.exports = { create, update };
`;

const hasEF = (arr) => arr.some((m) => m.includes('Entity Factory'));

describe('entity-factory 规则：默认行为不变', () => {
    test('apps 下写 CRUD 而不用 Entity Factory → ERROR（这是规则的本意，别放松）', () => {
        const r = run(makeService({ logicSource: EXTERNAL_STORE_LOGIC }));
        expect(hasEF(r.errors)).toBe(true);
    });

    test('core 下同样的代码 → 只是 warning，不是 error', () => {
        const r = run(makeService({ layer: 'core', logicSource: EXTERNAL_STORE_LOGIC }));
        expect(hasEF(r.errors)).toBe(false);
        expect(hasEF(r.warnings)).toBe(true);
    });

    test('ERROR 文案把两个出口都说出来（提示只给 singleton 会把人引向用坏语义）', () => {
        const r = run(makeService({ logicSource: EXTERNAL_STORE_LOGIC }));
        const msg = r.errors.find((m) => m.includes('Entity Factory'));
        expect(msg).toContain('// SAFE: singleton');
        expect(msg).toContain('// SAFE: external-store');
    });
});

describe('entity-factory 规则：两个豁免标记', () => {
    test('// SAFE: external-store → 放行，且记进 passed（留痕，可被 grep 扫出）', () => {
        const r = run(makeService({ logicSource: `// SAFE: external-store\n${EXTERNAL_STORE_LOGIC}` }));
        expect(hasEF(r.errors)).toBe(false);
        expect(r.passed.some((m) => m.includes('external-store'))).toBe(true);
    });

    test('// SAFE: singleton → 仍然放行（既有行为没被新标记挤掉）', () => {
        const r = run(makeService({ logicSource: `// SAFE: singleton\n${EXTERNAL_STORE_LOGIC}` }));
        expect(hasEF(r.errors)).toBe(false);
        expect(r.passed.some((m) => m.includes('单例配置'))).toBe(true);
    });

    test('两个标记的 passed 文案彼此可区分（审计时要能看出是哪一种豁免）', () => {
        const ext = run(makeService({ logicSource: `// SAFE: external-store\n${EXTERNAL_STORE_LOGIC}` }));
        const sgl = run(makeService({ logicSource: `// SAFE: singleton\n${EXTERNAL_STORE_LOGIC}` }));
        const extMsg = ext.passed.find((m) => m.includes('Entity Factory'));
        const sglMsg = sgl.passed.find((m) => m.includes('Entity Factory'));
        expect(extMsg).not.toEqual(sglMsg);
    });

    // 匹配是 content.includes('// SAFE: external-store')——`//` 前缀是判据的一部分，
    // 裸写 'SAFE: external-store' 不算数。与既有的 singleton 标记同样宽松（两者都不要求
    // 整行独占），这里只钉住"前缀不能省"，不把既有的宽松度当成待修的 bug。
    test("不带 '//' 前缀的字符串不构成标记", () => {
        const r = run(makeService({
            logicSource: `const note = 'SAFE: external-store';\n${EXTERNAL_STORE_LOGIC}`,
        }));
        expect(hasEF(r.errors)).toBe(true);
    });
});
