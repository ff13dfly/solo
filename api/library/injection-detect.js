/**
 * library/injection-detect.js — lightweight heuristic scan for prompt-injection-style
 * content in free-text string values.
 *
 * @why docs/planning/v1-implementation-plan.md P1 "AI prompt injection 防御·第二轮"
 *      (2026-07-03, narrowed scope). ingress's `dataSchema` whitelist (already shipped)
 *      constrains WHICH fields/types reach the event bus — it says nothing about what a
 *      declared `type:'string'` field's VALUE actually contains. This module is that
 *      missing check: a basic pattern backstop, not semantic detection (natural language
 *      can't be exhaustively pattern-matched). It exists to catch the obvious, high-signal
 *      cases (explicit instruction-override phrasing) and route them to human review —
 *      NOT to be a complete defense. Deliberately small: expand only after real
 *      false-positive/negative data justifies it (plan doc: "等有真实误报/漏报数据后再评估").
 *
 * Shared (not ingress-only) so other services can reuse the same vocabulary later —
 * see the plan doc's "非 ingress 注入面" residual gap.
 */

const PATTERNS = [
    // "ignore/disregard/forget ... previous/prior/above/all ... instructions/prompts/rules"
    { name: 'ignore-instructions', re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i },
    // "you are now X" / "act as X" / "pretend to be X" / "new instructions:" / "system prompt:"
    { name: 'role-override', re: /\b(you are now|act as|pretend (to be|you'?re)|new instructions?\s*:|system prompt\s*:)/i },
    // a line that opens with a fake chat role tag, mimicking prompt structure
    { name: 'role-tag-injection', re: /^\s*(system|assistant)\s*:/im },
    // explicit safety/guardrail bypass language
    { name: 'guardrail-override', re: /\b(disregard|override)\b[^.\n]{0,30}\b(system|safety|guardrails?)\b/i },
];

/** Scan a single string value for known injection patterns. Returns matched pattern names (empty = clean). */
function scanString(value) {
    if (typeof value !== 'string' || !value) return [];
    const hits = [];
    for (const p of PATTERNS) {
        if (p.re.test(value)) hits.push(p.name);
    }
    return hits;
}

/**
 * Scan every declared `type:'string'` field's value in `data` against `schemaItems`
 * (checkParams flat dialect — library/validate.js). Returns violation MESSAGES in the
 * same string-array shape checkParams uses, so callers can concat directly onto an
 * existing violations list.
 */
function scanDeclaredStrings(schemaItems, data) {
    const violations = [];
    if (!Array.isArray(schemaItems) || !data || typeof data !== 'object') return violations;
    for (const item of schemaItems) {
        if (!item || item.type !== 'string' || typeof item.name !== 'string') continue;
        const hits = scanString(data[item.name]);
        if (hits.length > 0) {
            violations.push(`'${item.name}' matched suspected prompt-injection pattern(s): ${hits.join(', ')}`);
        }
    }
    return violations;
}

module.exports = { PATTERNS, scanString, scanDeclaredStrings };
