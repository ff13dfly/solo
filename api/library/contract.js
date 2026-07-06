/**
 * Return-contract primitives — assert a handler's actual return value against the
 * shape declared in its introspection entry.
 *
 * SOLO already speaks ONE validation vocabulary: library/validate.checkParams over a
 * flat rule-item array `[{ name, required?, type?, pattern?, minLength?, maxLength? }]`
 * (the same dialect used by method `params`, orchestrator `input_schema`/`result_schema`).
 * This module reuses it for RETURN values — no new schema language, no ajv.
 *
 * Two declaration forms, both read straight off the introspection method object:
 *   - `returns_schema`: rule-item array — the rich, typed contract (preferred). New.
 *   - `returns`:        flat string array — the legacy discovery hint. Each key is
 *                       treated as a REQUIRED-but-untyped rule (subset semantics:
 *                       declared keys must be present; extra keys are always fine).
 *
 * Design (mirrors validate.js): pure, no I/O, never throws — safe to require anywhere,
 * including a future dev-mode runtime guard at the jsonrpc.success boundary. Deliberately
 * NOT wired into the Router (api/router/ is protected): `returns`/`returns_schema` are
 * parsed via require() by tests/linters, and the existing Router consumers of `returns`
 * (capability.js/manifest.js) are untouched — they keep reading the legacy string array.
 */

const { checkParams, PATTERNS } = require('./validate');

const VALID_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

/**
 * Normalize a method's declared return contract into the checkParams rule-item dialect.
 * Returns [] when nothing is declared (no contract → nothing to assert).
 */
function returnSchema(method) {
    // Prefer returns_schema only when it actually carries rules — an empty array must NOT
    // shadow a legacy `returns` contract (footgun: returns_schema:[] would erase enforcement).
    if (method && Array.isArray(method.returns_schema) && method.returns_schema.length) return method.returns_schema;
    if (method && Array.isArray(method.returns)) {
        return method.returns
            .filter((k) => typeof k === 'string' && k)
            .map((name) => ({ name, required: true }));
    }
    return [];
}

/**
 * Assert an actual handler return value against a method's declared contract.
 * Returns string[] of violations (empty = ok). Never throws.
 *
 * Subset semantics: every declared key must be present (extra keys are fine).
 * A bare-array (or non-object) result against an object-key contract fails with a
 * clear message — this is exactly the nexus.schedule.list-class bug (declares
 * ['items'] but returns a bare array).
 */
function checkReturn(method, result) {
    const schema = returnSchema(method);
    if (schema.length === 0) return [];
    const name = (method && method.name) || '(method)';
    if (Array.isArray(result)) {
        return [`'${name}' returns an array but declares object keys [${schema.map((s) => s.name).join(', ')}]`];
    }
    if (result === null || result === undefined || typeof result !== 'object') {
        return [`'${name}' returns ${result === null ? 'null' : typeof result} but declares object keys [${schema.map((s) => s.name).join(', ')}]`];
    }
    return checkParams(schema, result);
}

/**
 * Lint a method's return CONTRACT itself for well-formedness — static, no runtime.
 * Catches malformed `returns_schema` (bad type values, unknown pattern names, missing or
 * duplicate names) and `returns`-vs-`returns_schema` drift. Returns string[] (empty = ok).
 */
function lintReturnContract(method) {
    const errs = [];
    const name = (method && method.name) || '(unnamed)';
    if (method && Array.isArray(method.returns_schema)) {
        const seen = new Set();
        method.returns_schema.forEach((item, i) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                errs.push(`${name}.returns_schema[${i}] is not a rule object`);
                return;
            }
            if (typeof item.name !== 'string' || !item.name) {
                errs.push(`${name}.returns_schema[${i}] missing 'name'`);
            } else {
                if (seen.has(item.name)) errs.push(`${name}.returns_schema duplicate key '${item.name}'`);
                seen.add(item.name);
            }
            if (item.type !== undefined && !VALID_TYPES.has(item.type)) {
                errs.push(`${name}.returns_schema['${item.name}'] invalid type '${item.type}'`);
            }
            if (item.pattern !== undefined && !PATTERNS[item.pattern]) {
                errs.push(`${name}.returns_schema['${item.name}'] unknown pattern '${item.pattern}'`);
            }
        });
        // Coherence: a legacy `returns` key not covered by `returns_schema` is drift.
        if (Array.isArray(method.returns)) {
            const schemaNames = new Set(method.returns_schema.map((s) => s && s.name));
            method.returns.forEach((k) => {
                if (typeof k === 'string' && k && !schemaNames.has(k)) {
                    errs.push(`${name}: legacy returns key '${k}' is not present in returns_schema (drift)`);
                }
            });
        }
    }
    return errs;
}

/**
 * Verifiability of a dot-path (a fulfillment meta_field source.pick) against a method's
 * return contract. Only the FIRST segment is checkable from the flat dialect.
 *   - { status: 'ok' }            head key is a declared return key (and path is not nested)
 *   - { status: 'missing', ... }  head key is NOT a declared return key — a real bug
 *   - { status: 'unverifiable' }  no contract, or a nested path we cannot follow
 */
function checkPickPath(method, dotPath) {
    const schema = returnSchema(method);
    const head = String(dotPath == null ? '' : dotPath).split('.')[0];
    if (!head) return { status: 'missing', reason: 'empty pick path' };
    if (schema.length === 0) return { status: 'unverifiable', reason: `'${(method && method.name) || '?'}' declares no return contract` };
    const item = schema.find((s) => s && s.name === head);
    if (!item) return { status: 'missing', reason: `'${head}' is not a declared return key [${schema.map((s) => s.name).join(', ')}]` };
    if (String(dotPath).includes('.')) {
        // A nested pick into a SCALAR head is provably broken: the runtime does
        // pick.split('.').reduce((o,k)=>o?.[k], result), so ('RECEIVED').code === undefined
        // and the condition silently mis-branches. Treat as missing (a real bug), not just
        // unverifiable. Only object/array/untyped heads are genuinely unverifiable here.
        if (item.type === 'string' || item.type === 'number' || item.type === 'boolean') {
            return { status: 'missing', reason: `'${head}' is a ${item.type} but pick '${dotPath}' indexes into it (resolves to undefined at runtime)` };
        }
        return { status: 'unverifiable', reason: `nested path under '${head}' cannot be verified by the flat return contract` };
    }
    return { status: 'ok' };
}

module.exports = { returnSchema, checkReturn, lintReturnContract, checkPickPath, VALID_TYPES };
