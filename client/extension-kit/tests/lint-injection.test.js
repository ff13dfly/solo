/**
 * 注入清单交叉检查 —— 它守的是「manifest 的 js 数组 ↔ 代码里的 self.<全局>」这个契约。
 *
 * 这些用例逐条对应 steward 真机踩过的形态：摘掉一个注入文件、顺序排反、文件名写错。
 * 三者的共同点是**编译器一个都看不见**，运行时才炸，且错误文案常指向错误的方向。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintExtension } from '../lint-injection.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-lint-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** 写一个扩展目录：manifest（对象或原文字符串）+ 若干文件。 */
const ext = (manifest, files) => {
    fs.writeFileSync(path.join(root, 'manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    return lintExtension(root);
};

const section = (js, matches = ['https://example.com/*']) => ({
    manifest_version: 3, name: 't', version: '1',
    content_scripts: [{ matches, js }],
});

test('顺序正确、提供者在前：干净通过', () => {
    const out = ext(section(['lib.js', 'use.js']), {
        'lib.js': 'self.Collector = { id: 1 };',
        'use.js': 'const C = self.Collector; console.log(C.id);',
    });
    expect(out.errors).toEqual([]);
});

test('🔴 提供者被从本节摘掉（文件还在磁盘上）—— steward 踩过两次的那一种', () => {
    // 症状：面板永不出现 / `Cannot read properties of undefined (reading 'id')`，
    // 而后者的错误文案还写着"多半是页面改版"，方向完全指反。
    const out = ext(section(['use.js']), {
        'collectors/1688/index.js': 'self.Collector = { id: 1 };',   // 还在，只是不注入了
        'use.js': 'const C = self.Collector; console.log(C.id);',
    });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('没有注入提供它的 collectors/1688/index.js');
});

test('🔴 顺序排反：提供者在使用者后面 —— 同样只有运行时 undefined', () => {
    const out = ext(section(['use.js', 'lib.js']), {
        'lib.js': 'self.Collector = { id: 1 };',
        'use.js': 'console.log(self.Collector.id);',
    });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('排在**后面**');
});

test('注入清单里的文件在磁盘上不存在（改名/删文件时漏改 manifest）', () => {
    const out = ext(section(['gone.js']), { 'kept.js': 'self.X = 1;' });
    expect(out.errors.some((e) => e.includes('gone.js 在磁盘上不存在'))).toBe(true);
});

test('浏览器内置全局不误报 —— 只认"本扩展里有人赋值过"的名字', () => {
    const out = ext(section(['use.js']), {
        'use.js': 'console.log(self.location.href, window.getSelection(), globalThis.crypto);',
    });
    expect(out.errors).toEqual([]);
});

test('整行注释里的举例不误报（JSDoc 里天天写 self.Xxx）', () => {
    const out = ext(section(['use.js']), {
        'other.js': 'self.Collector = 1;',
        'use.js': '/**\n * 本文件依赖 self.Collector，由 collectors/ 提供。\n */\nconsole.log(1);',
    });
    expect(out.errors).toEqual([]);
});

test('solo-lint-ignore 豁免行尾引用（动态 executeScript 注入的那种）', () => {
    const files = {
        'other.js': 'self.Collector = 1;',
        'use.js': 'console.log(self.Collector);   // solo-lint-ignore Collector',
    };
    expect(ext(section(['use.js']), files).errors).toEqual([]);
    // 去掉豁免注释就该报出来——证明上面那条不是因为别的原因才绿的
    files['use.js'] = 'console.log(self.Collector);';
    expect(ext(section(['use.js']), files).errors).toHaveLength(1);
});

test('自己提供自己读，不算悬空', () => {
    const out = ext(section(['solo.js']), {
        'solo.js': 'self.Bag = self.Bag || {};\nself.Bag.n = 1;',
    });
    expect(out.errors).toEqual([]);
});

test('manifest 里的 // 注释要能解析 —— Chrome 容忍，JSON.parse 不容忍，派生项目真在用', () => {
    const out = ext(
        '{\n  // 节 0：采集轴\n  "manifest_version": 3, "name": "t", "version": "1",\n'
        + '  "content_scripts": [{ "matches": ["https://example.com/*"], "js": ["a.js"] }]\n}',
        { 'a.js': 'self.A = 1;' },
    );
    expect(out.errors).toEqual([]);
    expect(out.sections).toBe(1);
});

test('多节之间彼此独立：A 节注入的全局不算 B 节就位（两节打的是不同的页面）', () => {
    const out = ext({
        manifest_version: 3, name: 't', version: '1',
        content_scripts: [
            { matches: ['https://a.com/*'], js: ['lib.js', 'a.js'] },
            { matches: ['https://b.com/*'], js: ['b.js'] },
        ],
    }, {
        'lib.js': 'self.Shared = 1;',
        'a.js': 'console.log(self.Shared);',
        'b.js': 'console.log(self.Shared);',
    });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('content_scripts[1]');
});

test('通配 matches 出忠告但不算错（是取舍，不是 bug）', () => {
    const out = ext(section(['a.js'], ['<all_urls>']), { 'a.js': 'self.A = 1;' });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w) => w.includes('覆盖全网'))).toBe(true);
});

test('localhost/* 出忠告 —— match pattern 表达不了端口，会命中本机所有端口', () => {
    const out = ext(section(['a.js'], ['http://localhost/*']), { 'a.js': 'self.A = 1;' });
    expect(out.warnings.some((w) => w.includes('本机所有端口'))).toBe(true);
});

test('没有 content_scripts 的扩展也能跑（sample 起步时就是这样）', () => {
    const out = ext({ manifest_version: 3, name: 't', version: '1' }, { 'bg.js': 'globalThis.__solo = {};' });
    expect(out.errors).toEqual([]);
    expect(out.sections).toBe(0);
});

// sample/kit/ 是 sync.sh 的产物、已 gitignore，新 clone 里还不存在。
// 这条对着真 sample 跑，所以只在同步过之后才有意义——没同步就跳过，而不是红一片。
const synced = fs.existsSync(new URL('../sample/kit/messaging.js', import.meta.url));
(synced ? test : test.skip)('随仓库自带的 sample 必须是干净的（需先跑 bash sync.sh sample）', () => {
    const out = lintExtension(new URL('../sample', import.meta.url).pathname);
    expect(out.errors).toEqual([]);
});
