/**
 * agent.decide — the structured decision contract (the AI "brain" boundary).
 *
 * @why SOLO is designed to run AI-driven (nexus Sentinels react to events, orchestrator
 *      runs workflows) OR degrade to fully manual. For the AI-driven path to be safe, the
 *      LLM must produce a STRUCTURED, schema-bound decision the system can gate on — not
 *      free text. This module is that boundary:
 *
 *        1. INVERTED GATE — the caller fixes the closed `choices` set and the output
 *           `schema`. The model may ONLY pick a listed option and fill values; it never
 *           names a target stream / method / side effect (those live in Sentinel config).
 *           A decision outside the closed set is rejected → escalate.
 *
 *        2. DEGRADABILITY — every call is fail-soft. Provider error, unparseable output,
 *           an out-of-set decision, or confidence below threshold all return
 *           `escalate: true`, which the caller (nexus emit branch / orchestrator) turns
 *           into a human hand-off instead of an autonomous action. This is exactly the
 *           "degrade to manual" half of the design goal, expressed at the AI boundary.
 *
 * The provider (gemini/qwen/openai/mock) only does the LLM call + JSON coaxing and returns
 * `{ success, data }`. All the guarantees above live here, provider-agnostic.
 */
const config = require('../config');
const ProviderFactory = require('../providers');
const modelConfig = require('./model_config');
const jsonrpc = require('../handlers/jsonrpc');
const { createLogger } = require('../../../library/logger');

const logger = createLogger(config.serviceName || 'agent');

const DEFAULT_THRESHOLD = 0.6;

// Named tolerance tiers — a friendlier dial than a raw confidence number for Sentinel
// authors who don't want to reason about model calibration. Values are picked against
// OBSERVED real-model clustering (toFix.md: Gemini/Qwen return confidence 1.0/0.9
// near-constantly, regardless of correctness — the signal is not well-calibrated), not
// against an assumption that "0.8 confidence" means "80% likely correct":
//   - permissive = DEFAULT_THRESHOLD, i.e. today's behavior, unchanged for anyone who
//     doesn't opt in (only-add-not-break).
//   - strict is set just above Qwen's observed ~0.9 ceiling, so a "strict" Sentinel
//     escalates on that provider's output and only clears the most confidence-maxed
//     (~1.0) responses — a blunt but real lever until the confidence signal itself is
//     made more informative (prompt-injection resistance is a separate, harder problem
//     this does NOT address — see toFix.md).
const RISK_TOLERANCE_LEVELS = {
    permissive: DEFAULT_THRESHOLD,
    balanced: 0.8,
    strict: 0.95,
};

/** Build the escalate-to-human result. `decision: 'defer'` is the agreed sentinel. */
function escalation(reason, metadata = {}, confidence = 0) {
    return { decision: 'defer', confidence, reason, escalate: true, metadata };
}

/**
 * decide(params)
 * @param {object} params
 * @param {string}  params.instruction          - the policy/question to decide on (required)
 * @param {object}  [params.context]            - assembled data (event/fetch/sentinel); data only
 * @param {string[]} [params.choices]           - closed set of allowed decisions (inverted gate)
 * @param {object}  [params.schema]             - schema for extra `fields` values
 * @param {number}  [params.confidence_threshold] - below this ⇒ escalate (default 0.6); wins over risk_tolerance if both given
 * @param {string}  [params.risk_tolerance]     - named tier: 'permissive'|'balanced'|'strict' (see RISK_TOLERANCE_LEVELS); ignored if confidence_threshold is set
 * @param {string}  [params.model]              - model override
 * @returns {Promise<{decision, confidence, reason, escalate, fields?, metadata}>}
 *          Never throws for provider/parse failures — those degrade to escalate.
 */
async function decide(params = {}) {
    const { instruction, context, choices, schema, confidence_threshold, risk_tolerance, model } = params;

    // Without an instruction there is nothing to decide — this is a caller bug, not a
    // runtime degradation, so it is a hard error (the only throw in this module).
    if (!instruction || typeof instruction !== 'string') {
        throw jsonrpc.INTERNAL_ERROR('agent.decide requires a non-empty "instruction" string');
    }

    let threshold = DEFAULT_THRESHOLD;
    if (typeof confidence_threshold === 'number') {
        threshold = confidence_threshold;
    } else if (typeof risk_tolerance === 'string') {
        if (Object.prototype.hasOwnProperty.call(RISK_TOLERANCE_LEVELS, risk_tolerance)) {
            threshold = RISK_TOLERANCE_LEVELS[risk_tolerance];
        } else {
            logger.warn(`[decide] unknown risk_tolerance "${risk_tolerance}" — falling back to default threshold ${DEFAULT_THRESHOLD}`);
        }
    }
    const choiceSet = Array.isArray(choices) && choices.length ? choices.map(String) : null;

    const targetModel = await modelConfig.resolve('agent.decide', model);
    const provider = ProviderFactory.getProvider(config, targetModel);

    if (!provider || typeof provider.decide !== 'function') {
        // Provider can't make structured decisions → degrade to manual handling.
        return escalation(`provider has no decide capability`, { provider: 'none', model: targetModel });
    }

    let res;
    try {
        res = await provider.decide({ instruction, context: context || {}, choices: choiceSet, schema, model: targetModel });
    } catch (err) {
        // Network/timeout/etc — fail-soft. The system keeps running; a human decides.
        logger.warn(`[decide] provider error → escalate: ${err.message}`);
        return escalation(`agent unavailable: ${err.message}`, { provider: 'error', model: targetModel });
    }

    if (!res || res.success === false || !res.data || typeof res.data !== 'object') {
        return escalation(`no parseable decision: ${(res && res.error) || 'empty response'}`, (res && res.metadata) || { model: targetModel });
    }

    const data = res.data;
    let confidence = typeof data.confidence === 'number' ? data.confidence : Number(data.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    const reason = typeof data.reason === 'string' ? data.reason : '';
    const decision = data.decision;

    // Inverted gate: the model may ONLY pick from the closed choice set. Anything outside
    // it is treated as no-decision → escalate. The LLM can never invent an option.
    if (choiceSet && !choiceSet.includes(String(decision))) {
        return escalation(`decision "${decision}" not in allowed choices`, res.metadata, confidence);
    }

    // Degradability: a valid-but-low-confidence decision is still returned, but flagged
    // so the caller routes to a human rather than acting on it.
    const escalate = confidence < threshold;

    const out = {
        decision: String(decision),
        confidence,
        reason,
        escalate,
        metadata: res.metadata,
    };

    // fields: schema-bound extra values (values only — caller's payload_template interpolates them).
    if (schema && data.fields && typeof data.fields === 'object') {
        out.fields = data.fields;
    }

    return out;
}

module.exports = { decide };
