/**
 * 场景: Router 参数校验 —— "请求里"各类型异常参数检测 (param-validation)
 *
 * 用 api/sample 加厚后的 introspection schema 驱动 router/handlers/validator.js，模拟一个请求
 * 里可能出现的各种异常参数类型，断言两件事：
 *
 *   enforce 模式  — 异常参数被拒(-32602)，合法参数放行。证明"加强"真的拦得住。
 *   warn 模式(默认)— 同样的异常参数全部放行(只记日志)。证明上线零阻断、不误伤内部调用。
 *
 * 覆盖类型：blank-required / missing-required / 超 maxLength / 类型不符 / 控制字符 /
 *          id pattern 不符 / slug pattern 不符。
 *
 * 不需要 redis（纯校验逻辑）；redis 入参仅为满足 runner 约定。
 */
const path = require('path');

const VALIDATOR    = path.join(__dirname, '../../../../router/handlers/validator.js');
const SAMPLE_INTRO = path.join(__dirname, '../../../../sample/handlers/introspection.js');

const NUL = String.fromCharCode(0);

function loadValidator(mode) {
    process.env.PARAM_VALIDATION = mode;
    delete require.cache[require.resolve(VALIDATOR)];
    return require(VALIDATOR);
}

function schemaFor(methodName) {
    delete require.cache[require.resolve(SAMPLE_INTRO)];
    const methods = require(SAMPLE_INTRO);
    const m = methods.find((x) => x.name === methodName);
    return m ? m.params : [];
}

async function run(/* redis */) {
    console.log('\n═══ Router Param-Validation Simulation (driven by sample schema) ═══');
    let ok = true;
    const fail = (msg) => { ok = false; console.log(`  ❌ ${msg}`); };

    // sample.item.create → [ name(required,<=64), description(<=2000) ]
    const createSchema = schemaFor('sample.item.create');
    // sample.item.status → [ id(required,pattern:id,<=64), status(required,pattern:slug,<=32) ]
    const statusSchema = schemaFor('sample.item.status');

    if (!createSchema.length || !statusSchema.length) {
        fail('could not load sample schema (introspection changed?)');
        return ok;
    }

    // ── enforce 模式：异常必须被拒，合法放行 ──────────────────────────────
    {
        const V = loadValidator('enforce');
        const cases = [
            // [label, schema, params, shouldReject]
            ['valid create',             createSchema, { name: 'widget', description: 'ok' },          false],
            ['blank required name',      createSchema, { name: '   ' },                                true ],
            ['missing required name',    createSchema, { description: 'no name' },                     true ],
            ['name over maxLength(64)',  createSchema, { name: 'x'.repeat(65) },                       true ],
            ['wrong type name (number)', createSchema, { name: 12345 },                                true ],
            ['control char in name',     createSchema, { name: 'ev' + NUL + 'il' },                    true ],
            ['desc over maxLength(2000)',createSchema, { name: 'ok', description: 'y'.repeat(2001) },  true ],
            ['valid status',             statusSchema, { id: 'abc123', status: 'active' },             false],
            ['bad id pattern (space)',   statusSchema, { id: 'has space', status: 'active' },          true ],
            ['bad status slug (caps)',   statusSchema, { id: 'abc123', status: 'ACTIVE' },             true ],
        ];
        let pass = 0;
        for (const [label, schema, params, shouldReject] of cases) {
            const err = V.validateParams({ ...params }, schema);
            const rejected = !!err;
            if (rejected === shouldReject) pass++;
            else fail(`enforce: '${label}' expected ${shouldReject ? 'REJECT' : 'pass'}, got ${rejected ? 'REJECT' : 'pass'}`);
        }
        console.log(`  enforce mode: ${pass}/${cases.length} cases correct`);
    }

    // ── warn 模式(默认)：NEW 规则违例必须全部放行(零阻断) ────────────────
    //    只列 mode-gated 的新规则(blank / control-char / pattern)。
    //    size/type/missing 是既有的、始终强制的检查，不在 warn 豁免之列。
    {
        const V = loadValidator('warn');
        const bad = [
            ['blank name',      createSchema, { name: '   ' }],
            ['control char',    createSchema, { name: 'ev' + NUL + 'il' }],
            ['bad id pattern',  statusSchema, { id: 'has space', status: 'active' }],
            ['bad status slug', statusSchema, { id: 'abc123', status: 'ACTIVE' }],
        ];
        let through = 0;
        for (const [label, schema, params] of bad) {
            const err = V.validateParams({ ...params }, schema);
            if (!err) through++;
            else fail(`warn: '${label}' should pass through (warn-mode), but was REJECTED: ${err.message}`);
        }
        console.log(`  warn mode: ${through}/${bad.length} bad inputs passed through (non-blocking)`);
    }

    // 复位，避免污染后续场景
    delete process.env.PARAM_VALIDATION;

    console.log(`\n  ${ok ? '✅' : '❌'} Param-validation simulation ${ok ? 'passed' : 'FAILED'}\n`);
    return ok;
}

module.exports = { run };
