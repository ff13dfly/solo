/**
 * autocheck/static/mock-data.js — Base58 ID 规则的作用域回归测试。Hermetic: 把一个最小
 * service 树写进 os.tmpdir()，直接调规则模块，不起 Redis、不跑 checker 全流程。
 *
 * 为什么这几条值得单独钉（docs/feedback/done/mock-data-id-base58-vs-business-codes.md）：
 * 这条规则曾按**字面形状**抓任何 `id: '…'`，于是把 catalog 单测里的 ERP 业务编码
 * （`C1108`——聚水潭发的，含 0）判成 ERROR，precheck.sh 当场挡住部署。当时唯一的自救是
 * 把 `toMatchObject({ id: 'C1108' })` 改写成 `expect(...id).toBe('C1108')`：断言的东西
 * 一模一样，只是不命中那个正则 —— **规则的红绿取决于断言的句式**。三道收窄（只查播种
 * 数据、只查自己发 ID 的服务、不查注释）各自都能单独消掉那个误报，缺一条就会从别的门缝漏回来，
 * 所以逐条钉住；同时钉住「真问题仍被抓」，防止收窄收过头把规则修成一条永远不响的规则。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const rule = require('../static/mock-data');

/** 造一个最小服务树：config.js + 若干测试/种子文件（相对服务根的路径 → 内容） */
function makeService({ config, files }) {
    const svc = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-mock-rule-'));
    fs.writeFileSync(path.join(svc, 'config.js'), config);
    for (const [rel, body] of Object.entries(files)) {
        const dest = path.join(svc, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
    }
    return svc;
}

function base58Errors(servicePath) {
    const results = { passed: [], warnings: [], errors: [] };
    rule.check(servicePath, results);
    return results.errors.filter((e) => e.includes('Base58'));
}

const OWN_IDS = 'module.exports = { serviceName: "sample", idLengths: { item: 8 } };\n';
// catalog 的真实形状：idLengths 这个词**只出现在注释里**，说的正是「刻意没有」
const MIRRORS_EXTERNAL_IDS = `module.exports = {
    serviceName: 'catalog',
    // 刻意没有 idLengths：本服务**不生成 ID**，主键是两个 ERP 发的业务编码。
};
`;

describe('mock-data: Base58 ID 规则的作用域', () => {
    test('播种数据里的非法 ID 照报（收窄不能把规则修成永远不响）', () => {
        const svc = makeService({
            config: OWN_IDS,
            files: { 'tests/utils/seed.js': "module.exports = [{ id: 'AB0CD' }];\n" },
        });
        expect(base58Errors(svc)).toHaveLength(1);
    });

    test('*.test.js 里的字面量是断言、不是种子，不参与', () => {
        const svc = makeService({
            config: OWN_IDS,
            files: {
                'tests/query.test.js':
                    "test('x', () => { expect(o).toMatchObject({ id: 'C1108' }); });\n",
            },
        });
        expect(base58Errors(svc)).toHaveLength(0);
    });

    test('服务没声明 idLengths（= 不生成 ID）⇒ 整条规则跳过，即便在种子里', () => {
        const svc = makeService({
            config: MIRRORS_EXTERNAL_IDS,
            files: { 'tests/utils/seed.js': "module.exports = [{ id: 'C1108' }];\n" },
        });
        expect(base58Errors(svc)).toHaveLength(0);
    });

    test('注释不参与——讲"别这么写"的注释不该把规则自己点着', () => {
        const svc = makeService({
            config: OWN_IDS,
            files: {
                'tests/utils/seed.js':
                    "// 反例：别写成 id: 'AB0CD'\n/* 块注释里的 id: 'XY0ZW' 同理 */\nmodule.exports = [];\n",
            },
        });
        expect(base58Errors(svc)).toHaveLength(0);
    });

    test('`id` 必须是独立的词：uid / order_id 不是 id', () => {
        const svc = makeService({
            config: OWN_IDS,
            files: {
                'tests/utils/seed.js':
                    "module.exports = [{ uid: 'uid0abc9', order_id: 'AB0CD9' }];\n",
            },
        });
        expect(base58Errors(svc)).toHaveLength(0);
    });
});
