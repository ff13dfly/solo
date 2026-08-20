/**
 * env.test.js — library/env.js 的正确性证明。
 *
 * 本模块的契约只有一条：**输出与 `dotenv.parse()` 逐字节一致**（理由见 env.js 头部：
 * 服务看到的值由 dotenv 决定，脚本与它的任何偏差本身就是 bug）。所以这里的主力不是
 * "我觉得应该等于什么"，而是 §1 的**差分测试**——同一份输入喂给两个实现，断言相等。
 * dotenv 升级后若语义变了，§1 会红，那是**信号不是噪音**：说明服务的行为变了，
 * env.js 必须跟着变。
 *
 * §2 把契约用人能读的方式钉死（差分测试证明"一致"，但读不出"一致于什么"）。
 * §3 是两个真实事故的回归。§4 覆盖 read()。§5 是状态泄漏（正则 lastIndex）。
 * §6 CLI。§7 随机语料，把差分测试的覆盖面从手写用例扩到组合爆炸。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const env = require('../env');
const dotenv = require('dotenv');

const MODULE_PATH = path.join(__dirname, '..', 'env.js');

// 手写语料：每一条都是一个有名有姓的边界。
const CORPUS = [
    ['裸值', 'A=1'],
    ['等号两侧空格', 'A = 1'],
    ['单引号', "A='x y'"],
    ['双引号', 'A="x y"'],
    ['反引号', 'A=`x y`'],
    ['裸值含#（无前置空格也截断）', 'A=x#y'],
    ['裸值空格后#', 'A=x #y'],
    ['引号内的#保留', "A='x#y'"],
    ['双引号内的#保留', 'A="x#y"'],
    ['空值', 'A='],
    ['空双引号', 'A=""'],
    ['export 前缀', 'export A=1'],
    ['双引号内 \\n 展开', 'A="l1\\nl2"'],
    ['双引号内 \\r 展开', 'A="l1\\rl2"'],
    ['单引号内 \\n 不展开', "A='l1\\nl2'"],
    ['值里含等号', 'A=a=b'],
    ['小写 key', 'a_low=1'],
    ['点号 key', 'A.B=1'],
    ['连字符 key', 'A-B=1'],
    ['值尾随空格被 trim', 'A=x   '],
    ['引号内两端空格保留', "A='  p  '"],
    ['未闭合双引号（不抛，原样留引号）', 'A="oops'],
    ['未闭合单引号', "A='oops"],
    ['整行注释', '#c'],
    ['缩进注释', '   # c'],
    ['空文本', ''],
    ['只有换行', '\n\n\n'],
    ['多行混合', '# head\nA=1\n\nB=\'two words\'\nexport C="c#c"\n# tail'],
    ['CRLF 行尾', 'A=1\r\nB=2\r\n'],
    ['CR 行尾（老 mac）', 'A=1\rB=2\r'],
    // ↓ 变异测试补进来的：删掉 env.js 的换行归一化时，只有这一条会红。
    //   行尾的 \r 会被裸值正则和 trim 吃掉，唯有**引号内的字面 CR** 能区分
    //   （归一化 → "x\\ny"，不归一化 → "x\\ry"）。
    ['双引号内的字面 CR', 'A="x\ry"'],
    ['单引号内的字面 CR', "A='x\ry'"],
    ['重复 key 后者覆盖', 'A=1\nA=2'],
    ['值含中文', 'A=应用专用密码'],
    ['值含冒号 URL', 'A=redis://:pw@127.0.0.1:6379'],
    ['JSON 裸值', 'A={"requireTLS":true}'],
    ['JSON 单引号包裹', "A='{\"requireTLS\":true}'"],
    ['值含美元符', "A='p$ss'"],
    ['值含反斜杠', "A='C:\\\\path'"],
    ['无等号的行', 'JUSTTEXT'],
    ['key 前有空格', '   A=1'],
    ['冒号分隔（dotenv 也认）', 'A: 1'],
];

// ── §1 差分：与 dotenv 逐用例一致（本模块唯一的正确性判据）────────────────
describe('§1 与 dotenv.parse 差分一致', () => {
    test.each(CORPUS)('%s', (_label, src) => {
        expect(env.parse(src)).toEqual(dotenv.parse(src));
    });

    test('整份语料拼成一个大文件也一致', () => {
        const all = CORPUS.map(([, s]) => s).join('\n');
        expect(env.parse(all)).toEqual(dotenv.parse(all));
    });

    test('Buffer 入参与字符串入参一致（dotenv 接受 Buffer）', () => {
        const src = 'A=1\nB=\'two\'';
        expect(env.parse(Buffer.from(src))).toEqual(dotenv.parse(Buffer.from(src)));
    });
});

// ── §2 契约本身（差分证明"相等"，这里说明"等于什么"）──────────────────────
describe('§2 契约明面化', () => {
    test('三种引号都剥掉', () => {
        expect(env.parse("A='v'").A).toBe('v');
        expect(env.parse('A="v"').A).toBe('v');
        expect(env.parse('A=`v`').A).toBe('v');
    });

    test('只有双引号展开转义', () => {
        expect(env.parse('A="a\\nb"').A).toBe('a\nb');
        expect(env.parse("A='a\\nb'").A).toBe('a\\nb');
    });

    test('🔴 裸值在 # 处截断——密码含 # 必须加引号', () => {
        expect(env.parse('P=pa#ss').P).toBe('pa');          // 静默丢掉一半
        expect(env.parse("P='pa#ss'").P).toBe('pa#ss');     // 加引号才对
    });

    test('引号内空格保留，裸值两端 trim', () => {
        expect(env.parse("A='  x  '").A).toBe('  x  ');
        expect(env.parse('A=   x   ').A).toBe('x');
    });

    test('缺失的键就是缺失，不是 undefined 占位', () => {
        const r = env.parse('A=1');
        expect(Object.prototype.hasOwnProperty.call(r, 'B')).toBe(false);
    });

    test('CRLF 不会在值尾留下不可见的 \\r', () => {
        const r = env.parse('A=1\r\nB=2\r\n');
        expect(r.A).toBe('1');
        expect(r.B).toBe('2');
        expect(r.A.length).toBe(1);   // 若残留 \r 这里会是 2
    });
});

// ── §3 真实事故回归 ───────────────────────────────────────────────────────
describe('§3 回归：两处手写解析踩过的坑', () => {
    // upgrade.sh 用 grep|cut|tr 取值，引号不剥 → 取到 "'3600'"
    test("单引号端口：不能取到带引号的 '3600'", () => {
        expect(env.parse("PORTAL_OPERATOR_PORT='3600'").PORTAL_OPERATOR_PORT).toBe('3600');
    });

    // e2e/harness/setup.js 用正则 + trim，引号不剥 → 密码带引号去认证 → AUTH failed
    test('单引号密码：不能取到带引号的值（会 401，且报错完全不指向引号）', () => {
        const v = env.parse("REDIS_PASSWORD='abc123'").REDIS_PASSWORD;
        expect(v).toBe('abc123');
        expect(v.startsWith("'")).toBe(false);
    });

    test('JSON 值单引号包裹后原样取回（EMAIL_SMTP_OPTIONS 的形态）', () => {
        const v = env.parse(`EMAIL_SMTP_OPTIONS='{"requireTLS":true}'`).EMAIL_SMTP_OPTIONS;
        expect(v).toBe('{"requireTLS":true}');
        expect(() => JSON.parse(v)).not.toThrow();
    });
});

// ── §4 read() ─────────────────────────────────────────────────────────────
describe('§4 read()', () => {
    let dir;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-env-')); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('正常读取', () => {
        const p = path.join(dir, 'ok.env');
        fs.writeFileSync(p, "A='1'\nB=2\n");
        expect(env.read(p)).toEqual({ A: '1', B: '2' });
    });

    test('文件不存在 → 默认返回 {}（.env 对多数调用方是可选的）', () => {
        expect(env.read(path.join(dir, 'nope.env'))).toEqual({});
    });

    test('文件不存在 + required → 抛，且错误里带路径', () => {
        const p = path.join(dir, 'nope.env');
        expect(() => env.read(p, { required: true })).toThrow(/nope\.env/);
    });

    test('空文件 → {}', () => {
        const p = path.join(dir, 'empty.env');
        fs.writeFileSync(p, '');
        expect(env.read(p)).toEqual({});
    });
});

// ── §5 状态泄漏（/g 正则的 lastIndex 陷阱）────────────────────────────────
describe('§5 无状态：重复调用结果必须相同', () => {
    test('同一输入连解析 3 次结果一致', () => {
        const src = 'A=1\nB=2\nC=3';
        const first = env.parse(src);
        expect(env.parse(src)).toEqual(first);
        expect(env.parse(src)).toEqual(first);
        expect(Object.keys(first)).toEqual(['A', 'B', 'C']);
    });

    test('交替解析不同输入互不污染', () => {
        expect(env.parse('X=1')).toEqual({ X: '1' });
        expect(env.parse('AVERYLONGKEYNAME=2')).toEqual({ AVERYLONGKEYNAME: '2' });
        expect(env.parse('X=1')).toEqual({ X: '1' });
    });

    // ⚠️ 覆盖边界，别误以为这里守住了 env.js 里那行 `LINE.lastIndex = 0`：
    //    parse() 的 while 一定 drain 到 exec 返回 null，而那时 JS 会自动把 lastIndex
    //    归 0——所以删掉那行，本文件 63 条测试**全绿**（变异测试实测）。它是给未来的
    //    兜底（循环里一旦加 break/throw 就需要它），**无法通过公开 API 观察**。
    //    别因为"没测试覆盖"就把它当死代码删掉。
    test('（说明性）exec drain 到 null 后 lastIndex 由 JS 自动归零', () => {
        const r = /(\w+)=(\w+)/mg;
        while (r.exec('A=1\nB=2') !== null) { /* drain */ }
        expect(r.lastIndex).toBe(0);
    });
});

// ── §6 CLI（shell 调用方走这条）───────────────────────────────────────────
describe('§6 CLI', () => {
    let dir, file;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-envcli-'));
        file = path.join(dir, '.env');
        fs.writeFileSync(file, "PORTAL_OPERATOR_PORT='3600'\nPLAIN=x\n");
    });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const run = (args) => execFileSync('node', [MODULE_PATH, ...args], { encoding: 'utf8' });

    test('取单键：引号已剥，且无尾随换行（shell 直接用）', () => {
        expect(run([file, 'PORTAL_OPERATOR_PORT'])).toBe('3600');
    });

    test('键不存在 → 空输出 + 退出码 0（"没配"是合法状态，不是错误）', () => {
        expect(run([file, 'NOPE'])).toBe('');
    });

    test('不给键 → 输出全部 JSON', () => {
        expect(JSON.parse(run([file]))).toEqual({ PORTAL_OPERATOR_PORT: '3600', PLAIN: 'x' });
    });

    test('不给文件 → 退出码 2 + 用法提示到 stderr', () => {
        let code = 0;
        try { execFileSync('node', [MODULE_PATH], { encoding: 'utf8', stdio: 'pipe' }); }
        catch (e) { code = e.status; }
        expect(code).toBe(2);
    });

    test('端到端：bash 里取值，与 JS 侧一致', () => {
        const out = execFileSync('bash', ['-c', `node ${JSON.stringify(MODULE_PATH)} ${JSON.stringify(file)} PORTAL_OPERATOR_PORT`], { encoding: 'utf8' });
        expect(out).toBe(env.read(file).PORTAL_OPERATOR_PORT);
    });
});

// ── §7 随机语料差分（把覆盖面从手写用例扩到组合）──────────────────────────
// 固定种子的伪随机：可复现，不会今天绿明天红。
describe('§7 随机语料仍与 dotenv 一致', () => {
    const KEYS = ['A', 'B_C', 'd.e', 'F-G', 'LONG_KEY_NAME'];
    const VALUES = ['', '1', 'x y', 'a#b', 'a=b', '  pad  ', '{"j":1}', 'p$s', 'C:\\path', '应用密码', 'a\\nb'];
    const WRAPS = [(v) => v, (v) => `'${v}'`, (v) => `"${v}"`, (v) => `\`${v}\``];
    const PREFIX = ['', 'export ', '  '];

    // 线性同余，避免 Math.random 让失败不可复现
    let seed = 20260820;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    test('300 份随机 .env 全部一致', () => {
        for (let i = 0; i < 300; i++) {
            const lines = [];
            const n = 1 + rnd(5);
            for (let j = 0; j < n; j++) {
                const k = KEYS[rnd(KEYS.length)];
                const v = VALUES[rnd(VALUES.length)];
                lines.push(`${PREFIX[rnd(PREFIX.length)]}${k}=${WRAPS[rnd(WRAPS.length)](v)}`);
            }
            if (rnd(3) === 0) lines.push('# a comment');
            if (rnd(4) === 0) lines.push('');
            const src = lines.join(rnd(5) === 0 ? '\r\n' : '\n');
            // 失败时把语料打进断言消息，否则随机用例的红色无法定位
            expect({ src, out: env.parse(src) }).toEqual({ src, out: dotenv.parse(src) });
        }
    });
});
