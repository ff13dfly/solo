/**
 * 模块: 时间字段形态与时间源检查 (clock-check)
 *
 * 检测目标：把「时间怎么存」这条**唯一没有执行面的红线**装上门禁。
 *
 * @why  Solo 的 factory standard 是 **epoch ms**（`api/library/entity.js` 的 `toSortableMs()`
 *       头注是全仓唯一写下这句话的地方），而 `SKILL.md` 的红线清单里只有「别散落
 *       `Date.now()`，用 clock.js」一条——那管的是**时间源**（能不能在测试里冻结），
 *       完全没有约束**存储形态**。两者是独立的两条病：colony 的 `entryTime` 时间源
 *       老老实实走了 `clock.now()`，却包了一层 `.toISOString()`，只查时间源永远抓不到它。
 *
 *       后果不是显性报错，而是三层同时静默：
 *         · 本规则出现之前，autocheck 的 51 条规则一条都不碰时间字段；
 *         · `entities-definition` 只校验字段「有没有 type」，不校验 type 的取值，
 *           更不与实现对账——声明 `datetime`、实际写 ISO 串，中间没有任何对账面；
 *         · Portal 的 `renderValue` 用 `new Date(val)`，两种形态都能正常显示。
 *       于是 ISO 串混进以毫秒为前提的集合里：裸减法得 `NaN`，而返回 `NaN` 的比较器会让
 *       `Array.sort` **静默变成 no-op**（entity.js:15-25 的兜底注释自陈），`zAdd` 的 score
 *       也会成为 NaN。全程不抛异常。
 *
 * 判据（刻意只在**服务自己打自己的脸**时才 ERROR，其余 WARN）：
 *   1. [形态] 时间字段被写入 ISO 字符串，而它的声明蕴含数值形态  → ERROR
 *      「声明蕴含数值」= introspection 字段表声明 `number`，或 entities.js 声明 `datetime`
 *      且 introspection 没有把它声明成 `string`。
 *   2. [形态] 时间字段被写入 ISO 字符串，且**任何地方都没声明过形态**  → WARN
 *      没有声明就没有可对账的对象。这一档命中的多是会话/票据这类**内部 Redis 状态**，
 *      它们本就不该进 entities.js（Portal 会拿 entities 的 key 去拼 `${key}.list`）。
 *      要收敛成 epoch ms 是好事，但那是风格选择，不是契约违反——所以只提示，不拦。
 *   3. [形态] 声明为 ISO（entities.js 标 `format:'iso'`，或 introspection 字段表标
 *      `type:'string'`）→ 不报。core/user、apps/storage 走的就是这条，它们的
 *      introspection 里明写着 `// ISO string`，是**深思熟虑过的契约**，不是漂移。
 *   4. [声明] 同一字段 entities.js 说 `datetime`、introspection 说 `string` → WARN
 *      两处对 Portal 和 AI 讲的不是一回事，实现不可能同时满足。
 *   5. [读侧] 对声明为数值时刻的字段调用 `Date.parse()` → ERROR
 *      `Date.parse(<number>)` 返回 NaN 且不抛错。这是写侧那半病的镜像，也是实测中
 *      **线上真正在错的那半**（steward 一个仓库 7 处，见 §RE_DATE_PARSE 注释）。
 *   6. [时间源] 时间字段被赋值裸 `Date.now()` / `new Date().getTime()` → WARN
 *      应走 `api/library/clock.js`（可注入、测试可冻结）。全队 71 处存量，故只 WARN。
 *
 * ⚠️ 已知盲区（别把「门禁绿了」读成「这类 bug 没有了」）：
 *    ① 只跟一跳同文件局部变量。跨函数传参、跨文件传入、`obj[key] = iso` 这类动态键
 *       仍抓不到；要堵得上 AST，留待真的踩到再说。
 *    ② **只扫 `api/apps/<svc>/`**。同一个病在前端与浏览器插件里一模一样地发生——
 *       steward 实测的 7 处里有 4 处在 `client/`（React 看板的列表排序、插件的缓存新鲜度
 *       判断），本规则一处也够不着。那一半得靠 TS 类型层，不是这里。
 */

const fs = require('fs');
const path = require('path');

/** 不扫的目录：测试/桩数据/一次性迁移脚本不是运行时契约。 */
const SKIP_DIRS = new Set([
    'node_modules', 'tests', 'test', '__tests__', 'mock', 'mocks',
    'migrate', 'scripts', 'publish', 'cases', 'dist', 'coverage'
]);

/**
 * 时间字段名判据。
 * @why camelCase 边界**要求大写的 A/T**（`[a-z0-9](At|Time)$`）——这一条同时挡掉了
 *      `uptime`（ping 响应的 fleet-standard 字段，小写 t）与 `runtime`/`lifetime`，
 *      不必再维护一张否定清单。`STARTUP_TIME` 是全大写，同样天然落选。
 */
function isTimeFieldName(name) {
    return /[a-z0-9](At|Time)$/.test(name)      // createdAt / lastSeenAt / entryTime
        || /_(at|time)$/.test(name)             // created_at / entry_time
        || /^(stamp|timestamp)$/.test(name);
}

// 赋值左侧捕获：`key: v` / `key = v` / `obj.key = v`；排开 ==、===、!=、<=、>=
const ASSIGN = String.raw`(?:^|[\s{,;(.])([A-Za-z_$][\w$]*)\s*(?::|(?<![=!<>])=(?!=))\s*`;
const RE_ISO_WRITE  = new RegExp(ASSIGN + String.raw`[^;,\n]*?\.toISOString\s*\(\s*\)`);
const RE_BARE_NOW   = new RegExp(ASSIGN + String.raw`(?:Date\.now\s*\(\s*\)|new\s+Date\s*\(\s*\)\s*\.getTime\s*\(\s*\))`);

/**
 * 同文件内被赋成 ISO 串的局部变量名，例如 `const now = clock.nowDate().toISOString();`。
 *
 * @why 不追这一跳，这条规则会**恰好在它最该抓的那个案子上失灵**。steward 的
 *      `hive.node.lastSeenAt` 声明为 datetime、实际存 ISO（2026-09-04 修复），
 *      而它的写法正是 `const now = clock.nowDate().toISOString(); … lastSeenAt: now`——
 *      直接形态一次都没出现过。拿修复前的 `07f4ba8` 实跑，只查直接写入的版本
 *      报 0 条。规避不是刻意的：把 now 提出来复用是**更好**的写法，于是漂移
 *      天然长成了盲区的形状。
 */
const RE_ISO_VAR = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.toISOString\s*\(\s*\)/g;

/**
 * 读侧：`Date.parse(...)` 的实参里出现的时间字段名。
 *
 * @why 写侧只是病的一半，而**另一半才是线上真正在错的那半**。
 *      `Date.parse(1788488514012)` 返回 **NaN**——Date.parse 只吃字符串。于是一个
 *      epoch ms 字段被 Date.parse 读一次，就静默塌成 NaN：`NaN > x` 恒 false（新鲜度
 *      判断永不成立）、`NaN || 0` 落 0（zset score 被永久钉在 0）、比较器返回 NaN
 *      让 `Array.sort` 退化成不排序。steward 一个仓库里实测 7 处，分布在 3 个服务、
 *      2 个客户端、1 个运维脚本，由不同时期的改动引入——**每一处单看都是合理的
 *      `Date.parse(a) || Date.parse(b) || 0` 兜底写法**，作者只是不知道 a 和 b 是两种类型。
 *      这类 bug 语法合法、类型检查通过、单测全绿，只在真数据上错：除了静态规则没有别的抓法。
 *      （docs/feedback/time-field-shape-no-single-source.md §二）
 */
const RE_DATE_PARSE = /Date\.parse\s*\(([^)]*)\)/g;

/** 值就是某个已知 ISO 变量（`field: now` / `x.field = now`），不含更复杂的表达式。 */
function isoVarWrite(line, isoVars) {
    // 行尾允许成串的收尾符与空白：`const patch = { lastSeenAt: now };` 的 ` };` 是两个字符，
    // 只放行一个就会漏掉心跳这类最常见的写法（steward 07f4ba8:104 实测漏报）。
    const m = new RegExp(ASSIGN + String.raw`([A-Za-z_$][\w$]*)[\s,;)}\]]*$`).exec(line);
    if (!m) return null;
    return isoVars.has(m[2]) ? m[1] : null;
}

/** 递归收集服务下的 .js 源码（不含 SKIP_DIRS）。 */
function collectSources(dir, base, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) collectSources(full, base, out);
        } else if (e.isFile() && e.name.endsWith('.js') && !/\.test\.js$/.test(e.name)) {
            out.push({ full, rel: path.relative(base, full) });
        }
    }
    return out;
}

/** entities.js：字段名 → 声明 type。require 失败就当没声明（entities-definition 会另行报错）。 */
function readEntityFieldTypes(servicePath) {
    const p = path.join(servicePath, 'handlers/entities.js');
    const types = new Map(), formats = new Map();
    if (!fs.existsSync(p)) return { types, formats };
    let entities;
    try { entities = require(p); } catch { return { types, formats }; }
    for (const ent of Object.values(entities || {})) {
        if (!ent || typeof ent.fields !== 'object') continue;
        for (const [fname, fdef] of Object.entries(ent.fields)) {
            if (!fdef) continue;
            if (typeof fdef.type === 'string' && !types.has(fname)) types.set(fname, fdef.type);
            if (typeof fdef.format === 'string' && !formats.has(fname)) formats.set(fname, fdef.format);
        }
    }
    return { types, formats };
}

/**
 * introspection.js：字段名 → 线上契约 type。
 * @why 这里刻意用正则扫源码而不是 require——字段表（`{ name:'createdAt', type:'string' }`）
 *      是模块内部的 const，module.exports 出去的只有方法清单，require 拿不到。
 */
function readIntrospectionFieldTypes(servicePath) {
    const p = path.join(servicePath, 'handlers/introspection.js');
    const map = new Map();
    if (!fs.existsSync(p)) return map;
    let src;
    try { src = fs.readFileSync(p, 'utf-8'); } catch { return map; }
    const re = /\{\s*name:\s*['"]([\w$]+)['"]\s*,\s*type:\s*['"](\w+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) if (!map.has(m[1])) map.set(m[1], m[2]);
    return map;
}

/**
 * 综合两处声明，判定该字段应有的形态：'iso' | 'ms' | 'unknown'。
 *
 * @why entities.js 的 `format` 优先级最高：`type: 'datetime'` 是给 Portal 的**渲染**提示
 *      （"按时刻显示"），它并不回答"**存**成什么"。两件事此前被同一个词兼着表达，
 *      于是 apps/storage 出现了自相矛盾——entities.js 说 datetime、introspection.js
 *      明写 "ISO-8601 STRING (not a number)"。`format: 'iso' | 'epoch-ms'` 把"存什么"
 *      单独说清楚，渲染提示不受影响；缺省即 factory standard（epoch ms）。
 */
function declaredShape(field, entTypes, entFormats, wireTypes) {
    const fmt = entFormats.get(field);
    if (fmt === 'iso') return 'iso';
    if (fmt === 'epoch-ms') return 'ms';
    const wire = wireTypes.get(field);
    if (wire === 'string') return 'iso';
    if (wire === 'number' || wire === 'integer') return 'ms';
    const ent = entTypes.get(field);
    if (ent === 'datetime' || ent === 'number' || ent === 'integer') return 'ms';
    // @why 这里**刻意不给 `createdAt`/`updatedAt` 兜一个隐式的 'ms' 默认**，哪怕
    //      Entity Factory 盖这两个戳用的确实是 `Date.now()`。试过，是错的：finance 的
    //      `insight/logic/passwd.js:104` 写的是 **user 服务（bundle 自带）的记录**，
    //      那条记录的 updatedAt 本来就是 ISO，作者还就地注了原因——隐式默认把它误判成
    //      自相矛盾。服务写别家记录时，"这个字段该是什么形态"不由本服务决定。
    //      声明是唯一真源；实测三家（scout/steward/finance）本来就都显式声明了
    //      `createdAt: datetime`，默认一条也没多抓到。
    return 'unknown';
}

/**
 * 前 3 行内是否有 `typeof <name> === 'string'` 守卫。
 *
 * @why 「两种形态都吃」的兜底函数**必然**长成这样——先 `typeof x === 'number'` 直接返回，
 *      再 `typeof x === 'string'` 里调 `Date.parse`。那一处 Date.parse 是对的，不能报。
 *      steward 的 `hive/logic/node.js:lastSeenMs()` 实测触发过这个假阳性。
 *      这类函数正是 `clock.toMsOr()` 要取代的东西，但在它们被替换掉之前，不该被判红。
 */
function guardedAsString(name, lines, idx) {
    const re = new RegExp(String.raw`typeof\s+` + name + String.raw`\s*===?\s*['"]string['"]`);
    // 含当前行：单行写法 `if (typeof x === 'string') return Date.parse(x);` 很常见
    for (let k = Math.max(0, idx - 3); k <= idx; k++) if (re.test(lines[k])) return true;
    return false;
}

function check(servicePath, results) {
    const { types: entTypes, formats: entFormats } = readEntityFieldTypes(servicePath);
    const wireTypes = readIntrospectionFieldTypes(servicePath);

    // ── 判据 4：两处声明互斥 ────────────────────────────────────
    for (const [field, entType] of entTypes) {
        if (entType !== 'datetime') continue;
        if (entFormats.has(field)) continue;      // 已用 format 说清存储形态，不再是歧义
        if (wireTypes.get(field) === 'string') {
            results.warnings.push(
                `⚠️ [时间] 字段 "${field}" 声明不一致：entities.js 说 datetime（Portal 按时刻渲染），` +
                `introspection.js 说 string（线上契约是 ISO 串）——两处对 AI 和 Portal 讲的不是一回事`
            );
        }
    }

    // ── 判据 1/2/3/5：逐行扫写入面 ─────────────────────────────
    const files = collectSources(servicePath, servicePath, []);
    let isoErrors = 0, srcWarns = 0;

    for (const { full, rel } of files) {
        let content;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        // 预筛也必须含 Date.parse：读侧那半病的文件里，另外三个关键字一个都不出现
        // （steward `scout/logic/capture.js` 就是——整文件只有 Date.parse，此前被整个跳过）。
        if (!content.includes('toISOString') && !content.includes('Date.now')
            && !content.includes('new Date') && !content.includes('Date.parse')) continue;

        const isoVars = new Set();
        let vm;
        RE_ISO_VAR.lastIndex = 0;
        while ((vm = RE_ISO_VAR.exec(content)) !== null) isoVars.add(vm[1]);

        const lines = content.split('\n');
        lines.forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;

            const iso = RE_ISO_WRITE.exec(line);
            if (iso && isTimeFieldName(iso[1])) {
                const shape = declaredShape(iso[1], entTypes, entFormats, wireTypes);
                if (shape === 'ms') {
                    isoErrors++;
                    results.errors.push(
                        `❌ [时间] ${rel}:${i + 1} 字段 "${iso[1]}" 声明为数值时刻（epoch ms），` +
                        `实际写入 ISO 字符串——声明与实现不符。改用 clock.now()，` +
                        `或在 entities.js 该字段上标注 format: 'iso' 以承认这个例外`
                    );
                } else if (shape === 'unknown') {
                    // @why WARN 而非 ERROR：没有声明就没有可对账的对象。这一档命中的多是
                    //      **会话/票据这类内部 Redis 状态**（solo 自己的 bot/passport/admin
                    //      session 的 loginAt、steward 的 wsticket expiresAt），它们本就不该
                    //      进 entities.js（Portal 会拿 entities 的 key 去拼 `${key}.list`）。
                    //      对"从来没承诺过什么"的字段判 ERROR，是把风格偏好当契约违反。
                    srcWarns++;
                    results.warnings.push(
                        `⚠️ [时间] ${rel}:${i + 1} 时间字段 "${iso[1]}" 写入 ISO 字符串，形态未声明。` +
                        `Solo 的 factory standard 是 epoch ms（entity.js:toSortableMs 注释）——` +
                        `确实要存 ISO 就在 entities.js 上标注 format: 'iso' 把它变成被声明的例外`
                    );
                }
                return;   // 同一行不再按时间源重复报
            }

            const via = isoVarWrite(line, isoVars);
            if (via && isTimeFieldName(via)) {
                const shape = declaredShape(via, entTypes, entFormats, wireTypes);
                if (shape === 'ms') {
                    isoErrors++;
                    results.errors.push(
                        `❌ [时间] ${rel}:${i + 1} 字段 "${via}" 声明为数值时刻（epoch ms），` +
                        `实际写入的是同文件里一个 ISO 字符串变量——声明与实现不符。改用 clock.now()，` +
                        `或在 entities.js 该字段上标注 format: 'iso' 以承认这个例外`
                    );
                } else if (shape === 'unknown') {
                    srcWarns++;
                    results.warnings.push(
                        `⚠️ [时间] ${rel}:${i + 1} 时间字段 "${via}" 写入 ISO 字符串（经同文件变量），形态未声明。` +
                        `Solo 的 factory standard 是 epoch ms——确实要存 ISO 就在 entities.js 上标注 format: 'iso'`
                    );
                }
                return;
            }

            RE_DATE_PARSE.lastIndex = 0;
            let dp;
            while ((dp = RE_DATE_PARSE.exec(line)) !== null) {
                const names = dp[1].match(/[A-Za-z_$][\w$]*/g) || [];
                for (const n of new Set(names)) {
                    if (!isTimeFieldName(n)) continue;
                    if (guardedAsString(n, lines, i)) continue;
                    if (declaredShape(n, entTypes, entFormats, wireTypes) !== 'ms') continue;
                    isoErrors++;
                    results.errors.push(
                        `❌ [时间] ${rel}:${i + 1} 对 "${n}" 用了 Date.parse()，而它声明为数值时刻` +
                        `（epoch ms）——Date.parse 只吃字符串，传数字返回 NaN，且不抛错：` +
                        `比较恒 false、\`|| 0\` 落 0、比较器返回 NaN 让 Array.sort 退化成不排序。` +
                        `用 clock.toMs(v)（严格）或 clock.toMsOr(v, 0)（排序键）`
                    );
                }
            }

            const bare = RE_BARE_NOW.exec(line);
            if (bare && isTimeFieldName(bare[1])) {
                srcWarns++;
                results.warnings.push(
                    `⚠️ [时间] ${rel}:${i + 1} 时间字段 "${bare[1]}" 用了裸 Date.now()，` +
                    `应走 api/library/clock.js 的 clock.now()（可注入、测试可冻结）`
                );
            }
        });
    }

    if (isoErrors === 0 && srcWarns === 0) {
        results.passed.push('✅ [时间] 时间字段形态与时间源合规（epoch ms + clock.js）');
    }
}

module.exports = { check };
