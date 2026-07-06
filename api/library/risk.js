/**
 * Footprint risk classifier (VERSION.md §3.1 — 分层审批的风险判据).
 *
 * @why  The approval gate routes a workflow to the fast single-sign lane (C1) or
 *       the high-risk multi-sign lane based on WHAT IT DOES, not what the submitter
 *       claims — this is the confused-deputy guard. An external agent can't mark a
 *       money-moving workflow "low risk" to skip multi-sig: risk is derived from the
 *       footprint (the union of step + resolver methods) here.
 *
 * Rule (default-DENY on the read side): a method is READ-only iff its action segment
 * is a known read verb. Anything else — including unrecognized verbs — counts as a
 * WRITE, so a sneaky method name can't sneak into the LOW lane. A footprint is LOW
 * iff EVERY method is a read; otherwise HIGH.
 *
 * Why read-only = LOW is safe (confused-deputy): a pure-read workflow produces no
 * external effect on its own — to DO anything observable it must contain a write step
 * (send/record/update/…), which is itself a WRITE → HIGH. So the fast lane only ever
 * carries side-effect-free workflows. Deployments that consider reads of specific
 * services sensitive (e.g. bulk identity reads) can force them HIGH via
 * opts.sensitiveServices (config.approval.sensitiveServices) — empty by default.
 *
 * Method shape: `{service}.{entity}.{action}` or `{service}.{action}` — last
 * dot-segment is the action; first is the service.
 */

// Read verbs — methods whose action is one of these are non-mutating. Conservative:
// when in doubt a verb is NOT here, so it classifies as a write (→ HIGH).
const READ_VERBS = new Set([
    'get', 'list', 'status', 'resolve', 'snapshot', 'check', 'search', 'query',
    'find', 'fetch', 'read', 'view', 'info', 'categories', 'getpublic', 'peek',
    'stat', 'count', 'exists', 'has', 'profile', 'verify',
]);

// Suggested sensitive services (reads of these may be considered high-risk). NOT
// applied by default — a deployment opts in via config.approval.sensitiveServices.
// The write-verb rule already makes every effecting workflow HIGH, so this is only
// for treating *reads* of these services as sensitive (e.g. bulk identity reads).
const DEFAULT_SENSITIVE_SERVICES = new Set([
    'administrator', 'user',
]);

function actionOf(method) {
    if (typeof method !== 'string' || !method) return '';
    const parts = method.split('.');
    return parts[parts.length - 1].toLowerCase();
}
function serviceOf(method) {
    /* istanbul ignore next -- defensive: classifyFootprint pre-validates every method before calling serviceOf (mirrors actionOf's guard) */
    if (typeof method !== 'string' || !method) return '';
    return method.split('.')[0].toLowerCase();
}

function isReadMethod(method, readVerbs) {
    return readVerbs.has(actionOf(method));
}

/**
 * Classify a footprint (list of method names) → { level, reasons }.
 * @param {string[]} methods
 * @param {object} [opts]
 * @param {string[]} [opts.extraReadVerbs]      additional verbs to treat as reads
 * @param {string[]} [opts.sensitiveServices]   override sensitive-service set
 */
function classifyFootprint(methods = [], opts = {}) {
    const readVerbs = new Set(READ_VERBS);
    for (const v of (opts.extraReadVerbs || [])) readVerbs.add(String(v).toLowerCase());
    // Sensitive-service forcing is OPT-IN (empty by default): the write-verb rule
    // already covers every side-effecting workflow.
    const sensitive = opts.sensitiveServices
        ? new Set(opts.sensitiveServices.map(s => String(s).toLowerCase()))
        : new Set();

    const reasons = [];
    let level = 'LOW';

    for (const m of (methods || [])) {
        if (typeof m !== 'string' || !m) continue;
        if (sensitive.has(serviceOf(m))) {
            level = 'HIGH';
            reasons.push(`${m}: sensitive service '${serviceOf(m)}'`);
            continue;
        }
        if (!isReadMethod(m, readVerbs)) {
            level = 'HIGH';
            reasons.push(`${m}: write action '${actionOf(m)}'`);
        }
    }

    return { level, reasons };
}

module.exports = { classifyFootprint, isReadMethod, READ_VERBS, DEFAULT_SENSITIVE_SERVICES };
