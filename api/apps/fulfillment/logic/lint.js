/**
 * Fulfillment profile linter — proves a profile's state-machine conditions are fed by
 * data the source APIs actually return.
 *
 * The risk this closes (the reason it exists): a fulfillment PROFILE declares
 * `meta_fields[].source = { service, method, params?, pick }`. The operator portal
 * fetches `service.method`, reads `pick` (a dot-path) out of the response, and caches
 * it into `instance.meta[key]`. A transition's JsonLogic condition then branches on
 * `{ var: 'instance.meta.<key>' }`. JsonLogic treats a missing operand as null/falsy and
 * DOES NOT throw — so if `pick` names a field the source API never returns (drift, rename,
 * wrong field like collection.payment's `status` vs business `state`), the condition
 * silently mis-evaluates and the state machine takes the wrong branch. Nothing errors.
 *
 * This linter asserts, statically, against the cross-service introspection index:
 *   1. every sourced meta_field's `service.method` is a registered API method;
 *   2. its `pick`/`field` head segment is a declared return key of that method
 *      (verifiable only once the method declares a return contract — see library/contract);
 *   3. key-coupling: every transition-condition `instance.meta.<X>` is backed by a
 *      meta_field whose key is <X> (unbacked vars silently read undefined).
 *   4. action methods: every transition TASK action dispatches to a registered API method
 *      (a hallucinated/renamed action method fires a _task Router rejects at runtime).
 *   5. state-graph: the machine can leave the initial state DRAFT, and no transition fires
 *      from a state unreachable from DRAFT (a dead branch that can never run).
 *   6. action policy (opt-in via options.allowedActions): every TASK action is within the
 *      caller-supplied allow-list (mirrors the workflow H6 footprint pre-check) — lets an
 *      AI-submission lane reject out-of-policy profiles before activation.
 *
 * Pure, never throws. The caller supplies the introspection arrays (require()'d) — this
 * module does NO file I/O, so it is equally usable from a CI test or a dev script.
 */

const { checkPickPath } = require('../../../library/contract');

const META_VAR_PREFIX = 'instance.meta.';

/** Build { 'service.method': methodDecl } from an array of introspection arrays. */
function buildMethodIndex(introspectionArrays = []) {
    const idx = {};
    for (const arr of introspectionArrays) {
        if (!Array.isArray(arr)) continue;
        for (const m of arr) {
            if (m && typeof m.name === 'string' && m.name) idx[m.name] = m;
        }
    }
    return idx;
}

/** Add the meta-field <key> for a var path like 'instance.meta.<key>.<...>' (ignores empties). */
function addMetaKey(p, out) {
    if (typeof p === 'string' && p.startsWith(META_VAR_PREFIX)) {
        const key = p.slice(META_VAR_PREFIX.length).split('.')[0];
        if (key) out.add(key);
    }
}

/** Flatten all string leaves out of a (possibly nested array/object) value. */
function stringLeaves(v, acc = []) {
    if (typeof v === 'string') acc.push(v);
    else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, acc));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringLeaves(x, acc));
    return acc;
}

/**
 * Collect the meta-field keys a JsonLogic tree references via instance.meta.<key>.
 * Two reference forms exist in json-logic-js and BOTH are handled:
 *   - `{ var: 'instance.meta.<key>' }` (also the `{ var: ['instance.meta.<key>', default] }` array form)
 *   - `{ missing: ['instance.meta.<key>', ...] }` / `{ missing_some: [n, ['instance.meta.<key>', ...]] }`,
 *     where variable names are BARE STRINGS (NOT wrapped in `var`) — the idiomatic "did this
 *     sourced field actually arrive?" gate. Literal string operands of other ops are NOT
 *     collected (only var / missing operands name variables).
 */
function metaVarsInCondition(condition, out = new Set()) {
    if (!condition || typeof condition !== 'object') return out;
    if (Array.isArray(condition)) {
        condition.forEach((c) => metaVarsInCondition(c, out));
        return out;
    }
    for (const [op, val] of Object.entries(condition)) {
        if (op === 'var') {
            addMetaKey(Array.isArray(val) ? val[0] : val, out);
        } else if (op === 'missing' || op === 'missing_some') {
            stringLeaves(val).forEach((s) => addMetaKey(s, out));
        } else {
            metaVarsInCondition(val, out);
        }
    }
    return out;
}

/**
 * Lint one fulfillment profile against a method index.
 * Returns { errors: string[], warnings: string[] }. Never throws.
 *   - errors  = will silently misbehave at runtime (broken source method / pick / unbacked var).
 *   - warnings = correctness-adjacent but tolerable (deprecated `field` alias, unverifiable
 *                nested pick, value populated only via metaUpdate rather than a source).
 */
function lintProfile(profile, methodIndex = {}, options = {}) {
    const errors = [];
    const warnings = [];
    const pname = (profile && (profile.id || profile.name)) || '(profile)';
    const metaFields = Array.isArray(profile && profile.meta_fields) ? profile.meta_fields : [];
    const fieldKeys = new Set(metaFields.map((f) => f && f.key).filter(Boolean));

    // 1 + 2 — sourced meta_fields: real method, and pick path present in its return contract.
    for (const f of metaFields) {
        if (!f || !f.source) continue;
        // A sourced field with no key caches its fetched value under instance.meta[undefined]
        // (InstanceDetailModal does resolved[f.key]=value) — it can never feed a condition.
        if (typeof f.key !== 'string' || !f.key) {
            errors.push(`${pname}: a sourced meta_field is missing its 'key' — the fetched value can never be read by any condition`);
            continue;
        }
        const s = f.source;
        if (!s.service || !s.method) {
            warnings.push(`${pname}: meta_field '${f.key}' has an incomplete source (missing service/method) — skipped by the runtime fetcher`);
            continue;
        }
        const methodName = `${s.service}.${s.method}`;
        const method = methodIndex[methodName];
        if (!method) {
            errors.push(`${pname}: meta_field '${f.key}' source method '${methodName}' is not a registered API method`);
            continue;
        }
        // Response path: runtime reads `pick` with `field` as a legacy alias (InstanceDetailModal).
        const pick = s.pick != null ? s.pick : s.field;
        if (s.pick == null && s.field != null) {
            warnings.push(`${pname}: meta_field '${f.key}' uses deprecated source.field — rename to source.pick`);
        } else if (s.pick != null && s.field != null) {
            warnings.push(`${pname}: meta_field '${f.key}' declares both source.pick and source.field — field is ignored (dead config)`);
        }
        if (!pick) {
            errors.push(`${pname}: meta_field '${f.key}' source '${methodName}' has no pick/field path`);
            continue;
        }
        const verdict = checkPickPath(method, pick);
        if (verdict.status === 'missing') {
            errors.push(`${pname}: meta_field '${f.key}' picks '${pick}' from ${methodName} but ${verdict.reason}`);
        } else if (verdict.status === 'unverifiable') {
            warnings.push(`${pname}: meta_field '${f.key}' picks '${pick}' from ${methodName} — ${verdict.reason}`);
        }
        // source.params can reference OTHER cached meta fields (the cross-instance pattern,
        // e.g. params:{ id:{var:'instance.meta.procurement_instance_id'} }). An unbacked param
        // var resolves to undefined → the source RPC is called with a bad key → wrong fetch.
        for (const pv of metaVarsInCondition(s.params)) {
            if (!fieldKeys.has(pv)) {
                warnings.push(`${pname}: meta_field '${f.key}' source params reference instance.meta.${pv} with no declared meta_field — ensure '${pv}' is populated before this fetch`);
            }
        }
    }

    // 3 — key-coupling: condition vars instance.meta.<X> must be backed by a meta_field.
    const transitions = Array.isArray(profile && profile.transitions) ? profile.transitions : [];
    for (const t of transitions) {
        if (!t) continue;
        const vars = metaVarsInCondition(t.condition);
        for (const v of vars) {
            if (!fieldKeys.has(v)) {
                // Legitimate pattern: value supplied via metaUpdate/instance.update at transition
                // time (no declared meta_field). Can't statically prove it's populated → warn.
                warnings.push(`${pname}: transition '${t.event || '?'}' reads instance.meta.${v} with no declared meta_field — ensure '${v}' is supplied via metaUpdate/instance.update`);
                continue;
            }
            const mf = metaFields.find((f) => f && f.key === v);
            if (mf && !mf.source) {
                warnings.push(`${pname}: transition '${t.event || '?'}' reads instance.meta.${v}, but meta_field '${v}' has no source — its value must be supplied via metaUpdate/instance.update (not auto-fetched)`);
            }
        }

        // 4 — action methods: every TASK action must dispatch to a registered API method.
        //     A hallucinated/renamed method (the classic LLM-generation mistake) fires a
        //     _task that Router rejects at runtime — caught here BEFORE activation instead.
        //     Workflow actions target an orchestrator workflow id (not an introspection
        //     method), so they're out of scope. Action params' instance.meta.<X> vars warn
        //     if unbacked — the _task would otherwise fire with an undefined argument.
        const actions = Array.isArray(t.actions) ? t.actions : [];
        for (const a of actions) {
            if (!a || a.type === 'workflow') continue;
            if (typeof a.method !== 'string' || !a.method) {
                errors.push(`${pname}: transition '${t.event || '?'}' has a task action with no method`);
                continue;
            }
            if (!methodIndex[a.method]) {
                errors.push(`${pname}: transition '${t.event || '?'}' action method '${a.method}' is not a registered API method`);
            }
            for (const pv of metaVarsInCondition(a.params)) {
                if (!fieldKeys.has(pv)) {
                    warnings.push(`${pname}: transition '${t.event || '?'}' action '${a.method}' params reference instance.meta.${pv} with no declared meta_field — ensure '${pv}' is supplied before this transition`);
                }
            }
        }
    }

    // 5 — state-graph well-formedness. Instances are created in the system-initial state
    //     DRAFT (entities.js), so the machine must be able to LEAVE DRAFT, and a transition
    //     firing from a state unreachable from DRAFT can never run (a dead branch — a
    //     generated profile's most common structural mistake after method wiring).
    if (transitions.length) {
        const INITIAL = 'DRAFT';
        if (!transitions.some((t) => t && t.from === INITIAL)) {
            errors.push(`${pname}: no transition leaves the initial state ${INITIAL} — every instance is stuck on create`);
        }
        const reachable = new Set([INITIAL]);
        for (let grew = true; grew;) {
            grew = false;
            for (const t of transitions) {
                if (t && t.from != null && reachable.has(t.from) && t.to != null && !reachable.has(t.to)) { reachable.add(t.to); grew = true; }
            }
        }
        const deadFrom = new Set();
        for (const t of transitions) {
            if (t && t.from != null && t.from !== INITIAL && !reachable.has(t.from) && !deadFrom.has(t.from)) {
                deadFrom.add(t.from);
                warnings.push(`${pname}: state '${t.from}' is unreachable from ${INITIAL} — its transitions are dead branches`);
            }
        }
    }

    // 6 — action policy (optional). When the caller supplies an allow-list (e.g. the
    //     submitter's permitted methods — mirrors the workflow H6 footprint pre-check), every
    //     TASK action method must be within it, so an AI-submission lane can reject an
    //     out-of-policy profile BEFORE activation. No allow-list ⇒ no check (back-compat).
    const allow = options && options.allowedActions;
    if (allow) {
        const allowSet = allow instanceof Set ? allow : new Set(Array.isArray(allow) ? allow : []);
        for (const t of transitions) {
            for (const a of (Array.isArray(t && t.actions) ? t.actions : [])) {
                if (!a || a.type === 'workflow') continue;
                if (typeof a.method === 'string' && a.method && !allowSet.has(a.method)) {
                    errors.push(`${pname}: transition '${t.event || '?'}' action '${a.method}' is not in the allowed-action policy`);
                }
            }
        }
    }

    return { errors, warnings };
}

module.exports = { lintProfile, buildMethodIndex, metaVarsInCondition };
