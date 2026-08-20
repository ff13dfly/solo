//
// library/env.js — `.env` 文本解析（零依赖），给"自己读 .env 的脚本"用。
//
// ── 为什么存在 ────────────────────────────────────────────────────────────
// 一份 `.env` 有三类互不相同的消费者，各自的解析语义**并不一致**：
//   ① 服务进程 —— `require('dotenv').config()`
//   ② `deploy/run.sh` —— shell `source`（`set -a`）
//   ③ 运维/测试脚本 —— 自己 grep 或写正则取值
//
// 第③类每出现一次就要重新踩一遍引号：`REDIS_PASSWORD='abc'` 用裸正则取到的是
// **带引号的** `'abc'`，拿去认证就是 401/AUTH failed——而报错完全不指向引号，
// 看起来像密码错或权限问题。仓库里已确认两处这样的实现：
//   - `deploy/scaffold/upgrade.sh`（grep | cut | tr）
//   - `deploy/scaffold/e2e/harness/setup.js`（正则 + trim）
// 本模块就是把第③类收敛成一份，不再各写各的。
//
// ── 契约：输出与 `dotenv.parse()` **逐字节一致** ──────────────────────────
// 这是刻意的、也是本模块唯一的正确性判据：服务看到的值由 dotenv 决定，脚本若
// 和它有任何偏差，偏差本身就是 bug。因此这里**照抄 dotenv 的算法**（含它的怪癖，
// 见下），并由 `tests/env.test.js` 的差分测试逐用例断言两者相等——dotenv 升级
// 后语义若变，那个测试会红。**不要"顺手改得更合理"**：与 dotenv 一致 > 自洽。
//
// 需要知道的 dotenv 怪癖（都已覆盖）：
//   - 裸值在 `#` 处截断，**不需要前置空格**：`A=x#y` → `x`。密码里带 `#` 必须加引号。
//   - 单引号 / 双引号 / 反引号都算引号；**只有双引号**会把 `\n` `\r` 转成真换行。
//   - 引号内的空格与 `#` 原样保留；裸值则两端 trim。
//   - key 允许字母数字下划线**以及 `.` 和 `-`**。
//   - 引号未闭合时**不报错**，原样保留那个引号（`A="oops` → `"oops`）。这里同样
//     不抛——抛了就会出现"脚本炸了但服务跑得好好的"，那是新的不一致。
//
// ⚠️ 本模块解决不了①③与②（shell source）之间的分歧，那是文本形态问题：
//    `KEY={"a":1}` 裸值被 shell 剥掉双引号、被 dotenv 原样保留。**统一写成
//    `KEY='值'` 单引号是唯一三方都一致的形态**，这条属于 .env 的书写规范，
//    不是解析器能补救的。
//
const fs = require('fs');

// 与 dotenv 同款行正则（dotenv v16 lib/main.js）。改这里 = 改契约，先跑差分测试。
const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;

/**
 * 解析 `.env` 文本。
 * @param {string|Buffer} src
 * @returns {Object<string,string>} 键值对；不存在的键就是不存在（不会填 undefined）
 */
function parse(src) {
    const obj = {};
    if (src === null || src === undefined) return obj;

    // 先把换行统一成 \n（dotenv 同款第一步）。注意它**不只是**处理行尾：行尾的 \r
    // 其实已被裸值正则 [^#\r\n]+ 和 value.trim() 吃掉，真正需要这步的是**引号内的
    // 字面 CR** —— A="x<CR>y" 有归一化时得到 "x\ny"，没有则是 "x\ry"，与 dotenv 不一致。
    const lines = String(src).replace(/\r\n?/mg, '\n');

    // LINE 是模块级 /g 正则，exec 依赖 lastIndex。下面的 while 一定 drain 到 null，
    // 而 exec 返回 null 时 JS 会自动把 lastIndex 归 0 —— 所以这行在**当前**实现里
    // 够不到（变异测试证实：删掉它 63 条测试全绿）。保留是给将来的人兜底：循环里一旦
    // 出现 break 或 throw，lastIndex 就会留在半路，下次调用静默漏掉开头的键。
    LINE.lastIndex = 0;

    let match;
    while ((match = LINE.exec(lines)) !== null) {
        const key = match[1];
        let value = match[2] || '';
        value = value.trim();

        const maybeQuote = value[0];
        value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');
        if (maybeQuote === '"') {
            value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
        }
        obj[key] = value;
    }
    return obj;
}

/**
 * 读并解析一个 `.env` 文件。
 * @param {string} filePath
 * @param {{required?: boolean}} [opts] required=true 时文件缺失/不可读会抛；默认返回 {}。
 * @returns {Object<string,string>}
 */
function read(filePath, opts = {}) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        // 默认宽容：.env 对多数调用方是可选的（CI 里就没有）。要它必须在就传 required。
        if (opts.required) throw new Error(`读取 ${filePath} 失败：${e.message}`);
        return {};
    }
    return parse(raw);
}

module.exports = { parse, read };

// ── CLI：给 shell 调用方用 ────────────────────────────────────────────────
//   node api/library/env.js <file> <KEY>   → 打印该键的值（不存在则打印空）
//   node api/library/env.js <file>         → 打印全部键值的 JSON
// bash 侧这样用，引号逻辑就不必再实现一遍：
//   PORT=$(node api/library/env.js "$PROJ/.env" PORTAL_OPERATOR_PORT)
if (require.main === module) {
    const [file, key] = process.argv.slice(2);
    if (!file) {
        process.stderr.write('用法: node library/env.js <.env 路径> [KEY]\n');
        process.exit(2);
    }
    const vars = read(file);
    // 键不存在时打印空串并正常退出：对调用方而言"没配"是合法状态，不是错误。
    if (key) process.stdout.write(vars[key] === undefined ? '' : vars[key]);
    else process.stdout.write(JSON.stringify(vars, null, 2));
}
