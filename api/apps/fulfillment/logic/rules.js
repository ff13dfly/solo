/**
 * Rule Engine for Fulfillment
 * @why Decouples business logic from code. Rules are evaluated to decide
 *      if a transition is valid and what side-effects (_tasks) to trigger.
 *
 * The JsonLogic primitives now live in api/library/jsonlogic.js (shared with
 * nexus context assembly). This module re-exports the same surface so existing
 * imports (rules.evaluateCondition / rules.resolveParams) keep working unchanged.
 */
const { URL } = require('url');
const { evaluateCondition, resolveParams } = require('../../../library/jsonlogic');

// Masked/redacted UI scrape artifacts (e.g. '••••••', '****', '***', '9132****MA1X').
// Avoids false-positives on Markdown bold ('**word**') by requiring >=3 asterisks OR >=2
// asterisks flanked immediately by alphanumeric characters on BOTH sides.
const MASKED_VALUE_RE = /[•●▪]{2,}|\*{3,}|[A-Za-z0-9]\*{2,}[A-Za-z0-9]/;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_WALK_DEPTH = 32;

function getByPath(obj, dotPath) {
    if (!obj || typeof obj !== 'object' || typeof dotPath !== 'string' || !dotPath) return undefined;
    return dotPath.split('.').reduce((acc, part) => {
        if (!acc || typeof acc !== 'object' || PROTO_KEYS.has(part)) return undefined;
        return Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined;
    }, obj);
}

function normalizeUrlHostname(hostname) {
    if (!hostname || typeof hostname !== 'string') return '';
    let h = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!h) return '';
    const mappedHex = h.match(/^(?:::ffff:|(?:0+:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);
        const lo = parseInt(mappedHex[2], 16);
        h = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    } else {
        const mappedDot = h.match(/^(?:::ffff:|(?:0+:){5}ffff:)(\d+\.\d+\.\d+\.\d+)$/);
        if (mappedDot) h = mappedDot[1];
    }
    return h;
}

function isLoopbackOrLocalUrl(str) {
    if (typeof str !== 'string' || !/^https?:\/\//i.test(str.trim())) return null;
    let parsed;
    try {
        parsed = new URL(str.trim());
    } catch (_) {
        return null;
    }
    const h = normalizeUrlHostname(parsed.hostname);
    if (
        h === 'localhost' ||
        h.endsWith('.localhost') ||
        h === '::1' ||
        h === '::' ||
        /^0\./.test(h) ||
        /^127\./.test(h) ||
        /^(?:0+:){7}0*[01]$/.test(h)
    ) {
        return parsed.hostname;
    }
    return null;
}

function walkStrings(val, basePath = '', out = [], seen = new WeakSet(), depth = 0) {
    if (depth > MAX_WALK_DEPTH) return out;
    if (typeof val === 'string') {
        out.push({ path: basePath || 'meta', value: val });
        return out;
    }
    if (!val || typeof val !== 'object' || seen.has(val)) return out;
    seen.add(val);
    if (Array.isArray(val)) {
        val.forEach((item, idx) => walkStrings(item, basePath ? `${basePath}[${idx}]` : `[${idx}]`, out, seen, depth + 1));
        return out;
    }
    for (const [k, v] of Object.entries(val)) {
        if (PROTO_KEYS.has(k)) continue;
        walkStrings(v, basePath ? `${basePath}.${k}` : k, out, seen, depth + 1);
    }
    return out;
}

/**
 * Evaluate a transition's optional `evidence` quality gate against `mergedMeta`.
 * Pure function; returns { ok: boolean, violations: string[] }.
 *
 * Supported checks:
 *   - requiredFields: string[] (dot-paths into mergedMeta; non-null, non-blank, non-empty array/object)
 *   - rejectMasked: boolean (rejects '••••••', '****', '***', '138****1234', etc.)
 *   - rejectLoopbackUrls: boolean (rejects http(s)://127.0.0.1 / localhost / [::1] URLs)
 *   - minRows: number | { [field]: number }
 *   - minBytes: number | { [field]: number }
 */
function evaluateEvidenceGate(evidence, mergedMeta = {}) {
    const violations = [];
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        return { ok: true, violations };
    }
    const meta = (mergedMeta && typeof mergedMeta === 'object') ? mergedMeta : {};

    if (Array.isArray(evidence.requiredFields)) {
        for (const field of evidence.requiredFields) {
            if (typeof field !== 'string' || !field) continue;
            const v = getByPath(meta, field);
            if (
                v === undefined ||
                v === null ||
                typeof v === 'function' ||
                (typeof v === 'number' && !Number.isFinite(v)) ||
                (typeof v === 'string' && v.trim().length === 0) ||
                (Array.isArray(v) && v.length === 0) ||
                (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
            ) {
                violations.push(`evidence field '${field}' is required`);
            }
        }
    }

    const stringEntries = (evidence.rejectMasked || evidence.rejectLoopbackUrls)
        ? walkStrings(meta)
        : [];

    if (evidence.rejectMasked) {
        for (const { path, value } of stringEntries) {
            if (MASKED_VALUE_RE.test(value)) {
                violations.push(`evidence field '${path}' contains masked placeholder value`);
            }
        }
    }

    if (evidence.rejectLoopbackUrls) {
        for (const { path, value } of stringEntries) {
            const badHost = isLoopbackOrLocalUrl(value);
            if (badHost) {
                violations.push(`evidence field '${path}' contains unreachable loopback URL (${badHost})`);
            }
        }
    }

    if (evidence.minRows !== undefined && evidence.minRows !== null) {
        if (typeof evidence.minRows === 'number') {
            const actual = typeof meta.rowCount === 'number'
                ? meta.rowCount
                : Array.isArray(meta.rows)
                    ? meta.rows.length
                    : Array.isArray(meta.items)
                        ? meta.items.length
                        : NaN;
            if (!Number.isFinite(actual) || actual < evidence.minRows) {
                violations.push(`evidence row count below minimum (${Number.isFinite(actual) ? actual : 'missing'} < ${evidence.minRows})`);
            }
        } else if (typeof evidence.minRows === 'object' && !Array.isArray(evidence.minRows)) {
            for (const [field, min] of Object.entries(evidence.minRows)) {
                const raw = getByPath(meta, field);
                const actual = typeof raw === 'number' ? raw : (Array.isArray(raw) ? raw.length : NaN);
                if (!Number.isFinite(actual) || actual < min) {
                    violations.push(`evidence '${field}' row count below minimum (${Number.isFinite(actual) ? actual : 'missing'} < ${min})`);
                }
            }
        }
    }

    if (evidence.minBytes !== undefined && evidence.minBytes !== null) {
        if (typeof evidence.minBytes === 'number') {
            const actual = typeof meta.byteSize === 'number'
                ? meta.byteSize
                : typeof meta.bytes === 'number'
                    ? meta.bytes
                    : typeof meta.size === 'number'
                        ? meta.size
                        : NaN;
            if (!Number.isFinite(actual) || actual < evidence.minBytes) {
                violations.push(`evidence byte size below minimum (${Number.isFinite(actual) ? actual : 'missing'} < ${evidence.minBytes})`);
            }
        } else if (typeof evidence.minBytes === 'object' && !Array.isArray(evidence.minBytes)) {
            for (const [field, min] of Object.entries(evidence.minBytes)) {
                const raw = getByPath(meta, field);
                const actual = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Buffer.byteLength(raw) : NaN);
                if (!Number.isFinite(actual) || actual < min) {
                    violations.push(`evidence '${field}' byte size below minimum (${Number.isFinite(actual) ? actual : 'missing'} < ${min})`);
                }
            }
        }
    }

    return { ok: violations.length === 0, violations };
}

module.exports = { evaluateCondition, resolveParams, evaluateEvidenceGate };
