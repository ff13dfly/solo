#!/usr/bin/env node
/**
 * 注入清单交叉检查 —— manifest 的 `content_scripts[].js` ↔ 代码里的 `self.<全局>` 引用。
 *
 * 用法：
 *   node client/extension-kit/lint-injection.js <扩展目录>       # 如 sample 或 ../extension
 *
 * ## 它抓什么，为什么值得单独一道
 *
 * content script **不能用 ES module**，所以多文件组织的事实标准是「manifest 的 `js` 数组
 * 顺序注入 + 前面的文件往 `self.Xxx` 挂全局」。这个契约有两个失效点，**编译器一个都看不见**：
 *
 *   ① **把某个文件从 manifest 摘掉，别处对它那个全局的引用不会报错，而是运行时炸。**
 *      steward 因此踩了两次（2026-08 摘 `collectors/1688/` 之后）：一处让面板**永不出现**，
 *      一处炸 `Cannot read properties of undefined (reading 'id')`——而后者的错误文案还写着
 *      "多半是页面改版，选择器要核对"，把人指向完全错误的方向。
 *   ② **顺序错了**：提供者排在使用者后面。同样没有编译错误，只有运行时 undefined。
 *
 * 两者都是**纯静态可查**的，所以不该靠真机排查。
 *
 * ## 判据
 *
 * - 「提供者」= 扩展目录下**任何** .js 文件里的 `self.X = ` / `globalThis.X = ` / `window.X = `
 *   （含 `||=` `??=`）。刻意扫全目录而不是只扫已注入的文件——①那种情况下，被摘掉的文件
 *   还在磁盘上，正是它让这个全局名字**看起来**还有人提供。
 * - 「使用者」= 已注入文件里对上述名字的读取。只认候选名单里的名字，所以
 *   `self.location` / `window.getSelection` 这类内置不会误报。
 * - 整行都是注释的行先剔掉（JSDoc 里常写 `self.Xxx` 举例）。行尾注释要豁免就写
 *   `// solo-lint-ignore <全局名>`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'dist', 'build']);
const ASSIGN = /(?:self|globalThis|window)\.([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)?=(?!=)/g;
const READ = /(?:self|globalThis|window)\.([A-Za-z_$][\w$]*)/g;

/** Chrome 的 manifest 解析器容忍 `//` 注释，JSON.parse 不容忍。派生项目真的在用（steward）。 */
function readManifest(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const stripped = raw.split('\n')
        .map((line) => (/^\s*\/\//.test(line) ? '' : line))
        .join('\n');
    try {
        return JSON.parse(stripped);
    } catch (e) {
        throw new Error(`manifest.json 解析失败：${e.message}`);
    }
}

function walk(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, out);
        else if (ent.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/** 整行注释剔掉；行尾的 `solo-lint-ignore` 记下来。返回 [{ n, text, ignores:Set }] */
function codeLines(file) {
    return fs.readFileSync(file, 'utf8').split('\n').map((text, i) => {
        const trimmed = text.trim();
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
        const ignores = new Set();
        for (const m of text.matchAll(/solo-lint-ignore\s+([A-Za-z_$][\w$]*)/g)) ignores.add(m[1]);
        return { n: i + 1, text: isComment ? '' : text, ignores };
    });
}

/**
 * 扫一个扩展目录，返回 `{ errors, warnings, sections, files, globals }`。
 * @why 与 CLI 分开：门禁要能在 jest 里对着 fixture 断言，而 CLI 那半边要 process.exit。
 */
export function lintExtension(target) {
    const root = path.resolve(target);
    const manifestFile = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error(`不是扩展目录（没有 manifest.json）: ${root}`);

    const manifest = readManifest(manifestFile);
    const sections = manifest.content_scripts || [];
    const errors = [];
    const warnings = [];

    // ① 候选全局 = 全目录扫出来的提供者。file → Set<name>
    const providedBy = new Map();
    const candidates = new Set();
    for (const file of walk(root)) {
        const names = new Set();
        for (const { text } of codeLines(file)) {
            for (const m of text.matchAll(ASSIGN)) { names.add(m[1]); candidates.add(m[1]); }
        }
        if (names.size) providedBy.set(path.relative(root, file), names);
    }

    // ② 逐节检查：文件在不在、提供者有没有排在使用者前面
    sections.forEach((sec, si) => {
        const label = `content_scripts[${si}]`;
        const list = sec.js || [];

        for (const rel of list) {
            if (!fs.existsSync(path.join(root, rel))) {
                errors.push(`${label}: 注入清单里的 ${rel} 在磁盘上不存在`);
            }
        }

        // 到第 i 个文件为止已经就位的全局
        const readyAt = [];
        let acc = new Set();
        for (const rel of list) {
            readyAt.push(new Set(acc));
            for (const name of providedBy.get(rel) || []) acc.add(name);
        }

        list.forEach((rel, i) => {
            const full = path.join(root, rel);
            if (!fs.existsSync(full)) return;
            const own = providedBy.get(rel) || new Set();
            const before = readyAt[i];
            const seen = new Set();
            for (const { n, text, ignores } of codeLines(full)) {
                for (const m of text.matchAll(READ)) {
                    const name = m[1];
                    if (!candidates.has(name) || own.has(name) || before.has(name)) continue;
                    if (ignores.has(name)) continue;
                    const key = `${rel}:${name}`;
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const provider = [...providedBy].find(([, names]) => names.has(name));
                    const where = provider ? provider[0] : '(找不到提供者)';
                    const injectedLater = provider && list.includes(provider[0]);
                    errors.push(injectedLater
                        ? `${label}: ${rel}:${n} 读 self.${name}，但提供它的 ${where} 在本节里排在**后面** —— 顺序注入，提供者必须靠前`
                        : `${label}: ${rel}:${n} 读 self.${name}，但本节没有注入提供它的 ${where}`);
                }
            }
        });

        // ③ 忠告：过宽的 matches。每节最多各报一条，别把干净的项目吵成一片黄。
        const all = (sec.matches || []).filter((p) => /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/.test(p));
        const localhost = (sec.matches || []).filter((p) => /^https?:\/\/(localhost|127\.0\.0\.1)\/\*$/.test(p));
        if (all.length) warnings.push(`${label}: matches ${all.join(' ')} 覆盖全网 —— 确认你真的要在每个页面上注入`);
        if (localhost.length) {
            warnings.push(`${label}: matches ${localhost.join(' ')} 命中**本机所有端口**`
                + '（match pattern 表达不了端口），含你自己的开发前端和回归基准页 —— 见 README「通配 matches」');
        }
    });

    return {
        errors, warnings,
        sections: sections.length,
        files: sections.reduce((n, x) => n + (x.js || []).length, 0),
        globals: candidates.size,
    };
}

function main() {
    const target = process.argv[2];
    if (!target) {
        console.error('用法: node lint-injection.js <扩展目录>    (如 sample 或 ../extension)');
        process.exit(2);
    }
    let out;
    try {
        out = lintExtension(target);
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    for (const w of out.warnings) console.log(`⚠️  ${w}`);
    for (const e of out.errors) console.error(`✗ ${e}`);
    if (out.errors.length) {
        console.error(`\n注入清单交叉检查：${out.errors.length} 处不一致`);
        process.exit(1);
    }
    console.log(`✓ 注入清单一致（${out.sections} 节 / ${out.files} 个文件 / ${out.globals} 个全局）`);
}

// 只有当它是被直接执行的入口时才跑 CLI —— 被 import 时（门禁）保持安静。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
