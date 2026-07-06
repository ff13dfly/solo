/**
 * generate.js — NL requirement → fulfillment PROFILE JSON, gated by the linter.
 *
 * The valuable, deterministic core of "describe a requirement → get a profile": an
 * LLM proposes a profile; lint.js (against the REAL cross-service introspection index)
 * decides whether it's activatable; on errors we feed them back and ask the LLM to
 * repair, bounded. The LLM is INJECTED (`callLLM`) so this whole loop is unit-testable
 * with a fake — the lint gate is what makes generation trustworthy, not the LLM.
 *
 * Pure: no I/O, no relay. The handler wires `callLLM` (→ agent.chat) and `methodIndex`
 * (→ system.capability.list). Returns { profile, lintReport, attempts, ok } — it does
 * NOT create anything; a human reviews the candidate and creates it.
 */
const { lintProfile } = require('./lint');

// Marker the prompt carries so a deterministic/offline provider can recognise a
// profile-generation request (the live mock returns a canned profile on seeing it).
const PROFILE_MARKER = '[[FULFILLMENT_PROFILE_JSON]]';

/** Compact "method -> {returnKeys}" lines so the LLM grounds picks/actions on real methods. */
function buildContext(methodIndex = {}) {
    const out = [];
    for (const [name, decl] of Object.entries(methodIndex)) {
        const keys = Array.isArray(decl && decl.returns_schema) ? decl.returns_schema.map((r) => r && r.name).filter(Boolean) : [];
        out.push(keys.length ? `${name} -> {${keys.join(', ')}}` : name);
    }
    return out.sort();
}

// agent.chat caps `text` at 4000 chars, so the prompt is length-budgeted: the fixed
// instructions + requirement are kept whole, and the AVAILABLE-METHODS catalog is filled
// only up to the remaining budget (the rest is summarised as "+N more"). A final hard slice
// guarantees we never trip the Router param limit even for a near-max requirement.
const PROMPT_MAX = 3900;

function buildPrompt(requirement, methodIndex = {}) {
    const head = [
        `Generate a SOLO fulfillment PROFILE (a declarative state machine) as JSON. ${PROFILE_MARKER}`,
        'Output ONLY the JSON object — no prose, no code fences around anything else.',
        '',
        'SHAPE:',
        '{ "name": string,',
        '  "meta_fields": [{ "key": string, "source"?: { "service": string, "method": string (WITHOUT the service prefix — e.g. "order.get"), "params"?: object, "pick": string (a real RETURN field) } }],',
        '  "transitions": [{ "event": string, "from": STATE, "to": STATE, "condition"?: JsonLogic|null, "actions"?: [{ "type": "task", "method": "service.entity.action", "params"?: object }] }] }',
        'Rules: STATES are UPPERCASE; DRAFT is the initial state. Conditions/params are JsonLogic over {"var":"instance.meta.<key>"}. Same (event,from) may repeat with different conditions to branch.',
        '',
        'AVAILABLE METHODS (source picks must name a real return field; action methods must be real):',
    ];
    const foot = ['', 'REQUIREMENT:', String(requirement)];
    const fixedLen = head.join('\n').length + foot.join('\n').length + 2;

    const ctx = buildContext(methodIndex);
    const picked = [];
    let used = fixedLen;
    for (let i = 0; i < ctx.length; i++) {
        if (used + ctx[i].length + 1 > PROMPT_MAX) { picked.push(`… (+${ctx.length - i} more methods omitted)`); break; }
        picked.push(ctx[i]);
        used += ctx[i].length + 1;
    }
    return [...head, ...picked, ...foot].join('\n').slice(0, 4000);
}

function buildRepairPrompt(requirement, profile, errors) {
    return [
        `The previous fulfillment PROFILE JSON failed validation. Fix EVERY error and output ONLY corrected JSON. ${PROFILE_MARKER}`,
        'VALIDATION ERRORS:',
        ...errors.map((e) => `- ${e}`),
        '',
        'PREVIOUS JSON:',
        JSON.stringify(profile || {}, null, 2),
        '',
        'REQUIREMENT:',
        String(requirement),
    ].join('\n');
}

/** Pull the first balanced JSON object out of an LLM reply (tolerates code fences / prose). */
function extractJson(text) {
    if (typeof text !== 'string') return null;
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
            if (--depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
        }
    }
    return null;
}

function lintWith(profile, methodIndex) {
    if (!profile || typeof profile !== 'object') {
        return { errors: ['generation did not produce a valid JSON profile object'], warnings: [] };
    }
    return lintProfile(profile, methodIndex);
}

/**
 * Generate a lint-clean profile from an NL requirement.
 * @param requirement  NL string
 * @param profileId    optional id stamped onto the candidate
 * @param callLLM      async (prompt:string) => string   (the LLM reply text)
 * @param methodIndex  { 'service.method': { returns_schema? } } — the lint index
 * @param maxRepairs   how many repair round-trips after the first attempt (default 2)
 * @returns { profile, lintReport:{errors,warnings}, attempts, ok }
 */
async function generateProfile({ requirement, profileId = null, callLLM, methodIndex = {}, maxRepairs = 2 }) {
    if (!requirement || typeof requirement !== 'string') throw new Error('generateProfile: requirement (string) required');
    if (typeof callLLM !== 'function') throw new Error('generateProfile: callLLM function required');

    const ask = async (prompt) => {
        const profile = extractJson(await callLLM(prompt));
        if (profile && profileId) profile.id = profileId;
        return profile;
    };

    let profile = await ask(buildPrompt(requirement, methodIndex));
    let report = lintWith(profile, methodIndex);
    let attempts = 1;
    while (report.errors.length && attempts <= maxRepairs) {
        const repaired = await ask(buildRepairPrompt(requirement, profile, report.errors));
        if (repaired) profile = repaired;
        report = lintWith(profile, methodIndex);
        attempts++;
    }
    return { profile: profile || null, lintReport: report, attempts, ok: report.errors.length === 0 && !!profile };
}

module.exports = { generateProfile, buildPrompt, buildRepairPrompt, buildContext, extractJson, PROFILE_MARKER };
