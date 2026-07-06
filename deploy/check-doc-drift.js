#!/usr/bin/env node
/**
 * check-doc-drift.js — 防止"向导文档"与真实代码漂移的 CI 守护。
 *
 * 背景：docs/reference/overview.md、api/README.md 等文档把大量"产品愿景里的业务服务"
 * (commodity/sale/crm/erp…) 写成像是已存在，新 session/新成员会被误导、空跑很多轮。
 * CLAUDE.md §2 的"真实服务清单"是经核实的入口地图，它必须与 deploy/services.json
 * 严格一致——本脚本就守这一条不变式。
 *
 * 校验项：
 *   1. deploy/services.json 能解析，且每个服务的 path 文件真实存在。
 *   2. CLAUDE.md §2 表格里的服务名集合 == services.json 的服务名集合（双向）。
 *
 * 退出码非 0 即 CI 失败。其余文档(overview 等)只贴 ⚠️ 标签、不强校验——它们
 * 是 aspirational 的，强行对齐会丢失愿景信息。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

// ── 1. services.json 解析 + path 存在性 ───────────────────────────────
const servicesPath = path.join(ROOT, 'deploy/services.json');
let services;
try {
    services = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
} catch (e) {
    console.error(`❌ 无法解析 deploy/services.json: ${e.message}`);
    process.exit(1);
}
const serviceNames = new Set(services.map(s => s.name));
const servicePort = new Map(services.map(s => [s.name, s.port]));
for (const s of services) {
    if (!fs.existsSync(path.join(ROOT, 'api', s.path))) {
        errors.push(`services.json 的服务 "${s.name}" 指向 api/${s.path}，但该文件不存在`);
    }
}

// ── 2. CLAUDE.md §2 服务清单 + 端口 == services.json ──────────────────
const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
// §2 表格行形如：| **router** | 8600 | 网关 | ... |  （第 1 列服务名，第 2 列端口）
const sectionMatch = claudeMd.match(/## 2\. 真实服务清单[\s\S]*?(?=\n## )/);
const docNames = new Set();
const docPorts = new Map();   // name → 文档里写的端口
if (!sectionMatch) {
    errors.push('CLAUDE.md 找不到 "## 2. 真实服务清单" 小节——向导地图结构被改动，请同步本脚本');
} else {
    const re = /^\|\s*\*\*([a-z][a-z0-9-]*)\*\*\s*\|\s*(\d+)\s*\|/gm;
    let m;
    while ((m = re.exec(sectionMatch[0])) !== null) {
        docNames.add(m[1]);
        docPorts.set(m[1], Number(m[2]));
    }
}

for (const name of serviceNames) {
    if (!docNames.has(name)) errors.push(`服务 "${name}" 在 services.json 中，但 CLAUDE.md §2 表格缺失`);
}
for (const name of docNames) {
    if (!serviceNames.has(name)) errors.push(`CLAUDE.md §2 列了服务 "${name}"，但 services.json 中没有`);
}
// 端口一致性：§2 表格写的端口必须与 services.json 相同（防端口漂移，本轮 api/README 就栽过）
for (const [name, port] of docPorts) {
    const real = servicePort.get(name);
    if (real !== undefined && real !== port) {
        errors.push(`CLAUDE.md §2 中服务 "${name}" 端口写作 ${port}，但 services.json 是 ${real}`);
    }
}

// ── 2.5. config.js 的 portFor 兜底 == services.json 端口（端口单一真源，coherence-debt §5）─────
// services.json 是端口的运行权威（bundle 经 gen-entry 播 global.__SOLO_PORTS__）。但各服务 config.js
// 的 portFor(name, fallback) 兜底在 monolith / 单服务 from-source 启动时是**载荷性**的（那时 __SOLO_PORTS__
// 未播种，fallback 就是实际 listen 端口）。历史上靠手工 + CLAUDE.md §2 一句注释保持一致 —— 这里机器强制其
// === services.json，杜绝"端口第二真源"漂移（改一处忘另一处）。
for (const s of services) {
    const cfgPath = path.join(ROOT, 'api', path.dirname(s.path), 'config.js');
    if (!fs.existsSync(cfgPath)) {
        errors.push(`服务 "${s.name}" 缺 config.js（期望 api/${path.dirname(s.path)}/config.js）——端口兜底无处校验，请同步本脚本`);
        continue;
    }
    const cfgSrc = fs.readFileSync(cfgPath, 'utf8');
    const pm = cfgSrc.match(new RegExp(`portFor\\(\\s*['"]${s.name}['"]\\s*,\\s*(\\d+)\\s*\\)`));
    if (!pm) {
        errors.push(`服务 "${s.name}" 的 config.js 未见 portFor('${s.name}', <port>) 兜底调用——端口单一真源守门失效，请同步本脚本`);
        continue;
    }
    if (Number(pm[1]) !== s.port) {
        errors.push(`端口漂移：${s.name} 的 config.js portFor 兜底写作 ${pm[1]}，但 services.json 是 ${s.port}（coherence-debt §5：端口应以 services.json 为单一真源）`);
    }
}

// ── 3. 红线：每个服务 introspection 声明 ↔ index.js 注册 必须同步 ─────────
// CLAUDE.md §5 把"声明 + 注册必须同步"列为唯一硬约束，但此前无任何机器强制。
// 少一边都是红线：声明未注册 = AI/Portal 看得见却调不通；注册未声明 = 能调用却
// 不被发现。infra 方法（ping/methods/entities）豁免——它们普遍注册，是否进
// introspection 只是惯例差异。这就是"代码即提示词"可信的前提。
const INFRA = new Set(['ping', 'methods', 'entities']);
const REG_RE = /'(ping|methods|entities|[a-z][a-z0-9]*\.[a-z0-9.]+)'\s*:/g;
let devServices = [];
try { devServices = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/services.dev.json'), 'utf8')); } catch { /* dev fixtures optional */ }
const introTargets = [...services, ...devServices, { name: 'sample', path: 'sample/index.js' }];
for (const s of introTargets) {
    const introPath = path.join(ROOT, 'api', path.dirname(s.path), 'handlers', 'introspection.js');
    const indexPath = path.join(ROOT, 'api', s.path);
    if (!fs.existsSync(introPath)) continue;   // 无 introspection 的服务（如 router 网关）跳过
    let declaredArr;
    try { declaredArr = require(introPath).map(m => m.name); }
    catch (e) { errors.push(`${s.name}: 无法加载 handlers/introspection.js（${e.message}）`); continue; }
    const declared = new Set(declaredArr);
    const src = fs.readFileSync(indexPath, 'utf8');
    const registered = new Set();
    let mm;
    while ((mm = REG_RE.exec(src)) !== null) registered.add(mm[1]);
    REG_RE.lastIndex = 0;
    for (const name of declaredArr) {
        if (!INFRA.has(name) && !registered.has(name)) {
            errors.push(`红线 [${s.name}]：introspection 声明了 "${name}"，但 index.js 未注册 handler（AI 可见却调不通）`);
        }
    }
    for (const name of registered) {
        if (!INFRA.has(name) && !declared.has(name)) {
            errors.push(`红线 [${s.name}]：index.js 注册了 "${name}"，但 introspection 未声明（可调用却 AI/Portal 不可见）`);
        }
    }
}

// ── 4. 脚手架 README 模板不得硬编码前端 bundle 版本号 ────────────────────
// 前端 tarball 版本钉在 .solo-version 上，由 init.sh 用 {{SOLO_VERSION}} 占位符注入。
// README 里写死 vX.Y.Z.tar.gz 会随版本升级 stale（实际就停在 v1.0.0 而仓库已 v1.1.0）——
// 这与本脚本守的服务清单漂移是同一类问题，同样强制：模板里只能用占位符。
const README_TEMPLATES = [
    'deploy/scaffold/README.portal.md',
    'deploy/scaffold/README.client.md',
];
const HARDCODED_BUNDLE_VERSION = /\.v\d+\.\d+\.\d+\.tar\.gz/;
for (const rel of README_TEMPLATES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (HARDCODED_BUNDLE_VERSION.test(line)) {
            errors.push(`${rel}:${i + 1} 硬编码了前端 bundle 版本（${line.trim()}）——改用 "v{{SOLO_VERSION}}"，由 init.sh 按 .solo-version 注入`);
        }
    });
}

// ── 5. 脚手架契约文档包（docs/）：必须存在，且 workflow 示例对引擎合法 ──────
// init.sh 把 docs/{README.md,authoring/{service,events,workflows}.md,authoring/workflow-examples/*.json}
// 下发给每个新项目，让下游 AI/人只凭脚手架就能写出 wire 兼容的服务/事件/workflow。这里守三件事：
//   (a) 文档包还在（README 索引 + service/events/workflows 三份 + 至少一个示例）——别在重构脚手架时漏带；
//   (b) 每个示例对照 orchestrator create()/runner 的硬规则仍然合法——示例若教错，
//       下游照抄就炸。规则取自 logic/workflow.js create() 与 logic/runner.js。
const WF_KIT = path.join(ROOT, 'deploy/scaffold/docs/authoring');
const WF_EXAMPLES = path.join(WF_KIT, 'workflow-examples');
let wfExampleCount = 0;
// (a) whole-pack presence: README index + the three engine-aligned authoring guides.
for (const _rel of ['docs/README.md', 'docs/authoring/service.md', 'docs/authoring/events.md', 'docs/authoring/workflows.md']) {
    if (!fs.existsSync(path.join(ROOT, 'deploy/scaffold', _rel))) {
        errors.push(`deploy/scaffold/${_rel} 缺失——脚手架契约文档包未下发（init.sh 第 6a 步会复制 docs/）`);
    }
}
if (!fs.existsSync(WF_EXAMPLES)) {
    errors.push('deploy/scaffold/docs/authoring/workflow-examples/ 缺失——至少要带一个可跑示例');
} else {
    const files = fs.readdirSync(WF_EXAMPLES).filter(f => f.endsWith('.json'));
    if (files.length === 0) errors.push('deploy/scaffold/docs/authoring/workflow-examples/ 下没有任何 .json 示例');
    const VAR_ROOTS = new Set(['input', 'config', 'step', 'context']);  // runner.js resolveVariable 只认这四个根
    for (const f of files) {
        const rel = `deploy/scaffold/docs/authoring/workflow-examples/${f}`;
        let wf;
        try { wf = JSON.parse(fs.readFileSync(path.join(WF_EXAMPLES, f), 'utf8')); }
        catch (e) { errors.push(`${rel} 不是合法 JSON：${e.message}`); continue; }
        wfExampleCount++;
        // create() 必填：category / name / desc / steps[]
        for (const k of ['category', 'name', 'desc']) {
            if (!wf[k]) errors.push(`${rel} 缺顶层必填字段 "${k}"（create() 会拒）`);
        }
        if (!Array.isArray(wf.steps) || wf.steps.length === 0) {
            errors.push(`${rel} 的 steps 必须是非空数组`);
            continue;
        }
        for (const st of wf.steps) {
            for (const k of ['id', 'service', 'method']) {
                if (!st[k]) errors.push(`${rel} 某 step 缺 "${k}"（create() 会拒）`);
            }
            if (!st.params || typeof st.params !== 'object') {
                errors.push(`${rel} step "${st.id || '?'}" 的 params 必须是对象`);
            }
            // 头号坑：condition 必须是 JsonLogic 对象，字符串会被 runner 判假
            if ('condition' in st && (typeof st.condition !== 'object' || Array.isArray(st.condition))) {
                errors.push(`${rel} step "${st.id}" 的 condition 必须是 JsonLogic 对象，不能是字符串/数组`);
            }
            // $ 变量根必须 ∈ {input,config,step,context}（防示例教用 $resolved/$consensus）
            for (const v of (JSON.stringify(st.params).match(/"\$[a-zA-Z_]+/g) || [])) {
                const root = v.slice(2);
                if (!VAR_ROOTS.has(root)) {
                    errors.push(`${rel} step "${st.id}" 用了未知变量根 "$${root}"——runner 只认 $input/$config/$step/$context`);
                }
            }
        }
    }
}

// ── 6. 脚手架下游 skill：solo-service 守门技能必须就位且完整 ──────────────
// init.sh 第 6b 步把 .claude/skills/solo-service/SKILL.md 下发给每个新项目——它是"被执行的契约"：
// 指向 docs/authoring + api/sample，并以 autocheck --static 收口。守三件事，别在重构脚手架时把它掏空：
//   (a) 文件还在且有 frontmatter（name: solo-service + description，否则 Claude Code 不会发现它）；
//   (b) 仍指向 autocheck 门禁（这条没了，skill 就退化成一篇散文，约束失效）；
//   (c) 仍指向 docs/authoring（参考源，下游照着写的依据）。
const SKILL = path.join(ROOT, 'deploy/scaffold/.claude/skills/solo-service/SKILL.md');
if (!fs.existsSync(SKILL)) {
    errors.push('deploy/scaffold/.claude/skills/solo-service/SKILL.md 缺失——下游守门 skill 未下发（init.sh 第 6b 步会复制它）');
} else {
    const s = fs.readFileSync(SKILL, 'utf8');
    if (!/^---[\s\S]*?\nname:\s*solo-service[\s\S]*?\ndescription:\s*\S[\s\S]*?\n---/m.test(s)) {
        errors.push('SKILL.md 的 frontmatter 不完整——必须有 `name: solo-service` + 非空 `description:`（否则 Claude Code 不会发现/触发它）');
    }
    if (!/autocheck/.test(s)) {
        errors.push('SKILL.md 不再提及 autocheck 门禁——skill 退化为散文，约束失效（应保留 `node api/autocheck/checker.js … --static` 这道关）');
    }
    if (!/docs\/authoring/.test(s)) {
        errors.push('SKILL.md 不再指向 docs/authoring——下游失去照着写的参考源');
    }
}

// ── 报告 ──────────────────────────────────────────────────────────────
if (errors.length) {
    console.error('❌ 文档漂移检查未通过：\n' + errors.map(e => `   • ${e}`).join('\n'));
    console.error('\n修复：更新 CLAUDE.md §2 表格 / deploy/services.json，或同步 introspection 声明 ↔ index.js 注册。');
    process.exit(1);
}
console.log(`✅ 文档漂移检查通过：CLAUDE.md §2 ↔ services.json（${serviceNames.size} 服务 + 端口）+ config.js portFor 兜底 ↔ services.json 端口一致（端口单一真源）+ 各服务 introspection ↔ index 注册一致 + 脚手架 README 无硬编码 bundle 版本 + 契约文档包就位（docs/README + authoring/{service,events,workflows}.md + ${wfExampleCount} workflow 示例，引擎合法）+ 下游守门 skill 就位（solo-service，含 autocheck 门禁）。`);
