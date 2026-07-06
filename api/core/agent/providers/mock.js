/**
 * Mock LLM provider — offline, deterministic, no API key.
 *
 * @why The real providers (gemini/qwen/openai) all need live API keys + network +
 *      non-deterministic output, which is exactly why core/agent/** is excluded from
 *      CI and the e2e harness. This provider lets the agent service run end-to-end in
 *      a hermetic harness so the nexus → context assembly → LLM → output loop can be
 *      tested deterministically. Enabled by AI_PROVIDER=mock.
 *
 * Implements the same method surface the capabilities call (chat / parseText /
 * translateText). `chat` echoes its prompt so a test can assert that the rendered
 * context (e.g. a fetched amount) actually reached the model.
 */
module.exports = class MockProvider {
    constructor(config) {
        this.config = config || {};
    }

    async chat({ text, model } = {}) {
        // Offline affordance for fulfillment.profile.generate: when the prompt carries the
        // profile-generation marker, return a canned, lint-clean order-flow profile so the
        // generate → lint → create → drive path is deterministically testable without a live
        // LLM (mirrors decide()'s MOCK_DECIDE). Real providers synthesize from the requirement.
        if (typeof text === 'string' && text.includes('[[FULFILLMENT_PROFILE_JSON]]')) {
            const profile = {
                name: 'generated order flow (mock)',
                meta_fields: [
                    { key: 'amount', source: { service: 'market', method: 'order.get', params: { id: { var: 'instance.meta.orderId' } }, pick: 'amount' } },
                    { key: 'decision' },
                ],
                transitions: [
                    { event: 'pay', from: 'DRAFT', to: 'PAID', condition: null,
                      actions: [{ type: 'task', method: 'market.order.pay', params: { id: { var: 'instance.meta.orderId' } } }] },
                    { event: 'review', from: 'PAID', to: 'CONFIRMED',
                      condition: { '==': [{ var: 'instance.meta.decision' }, 'approve'] },
                      actions: [{ type: 'task', method: 'market.order.confirm', params: { id: { var: 'instance.meta.orderId' } } }] },
                    { event: 'review', from: 'PAID', to: 'HELD',
                      condition: { '!=': [{ var: 'instance.meta.decision' }, 'approve'] },
                      actions: [{ type: 'task', method: 'market.order.hold', params: { id: { var: 'instance.meta.orderId' } } }] },
                ],
            };
            return { success: true, text: JSON.stringify(profile), metadata: { provider: 'mock', model: model || 'mock-1', canned: 'fulfillment-profile' } };
        }
        return {
            success: true,
            // Echo the prompt so callers can verify the assembled context reached the LLM.
            text: `MOCK_REPLY::${text ?? ''}`,
            metadata: { provider: 'mock', model: model || 'mock-1', echo: true },
        };
    }

    async parseText({ text } = {}) {
        return { success: true, data: { echo: text ?? '' }, metadata: { provider: 'mock' } };
    }

    async translateText({ text, targetLang } = {}) {
        return {
            success: true,
            translatedText: `MOCK_TR[${targetLang || 'auto'}]::${text ?? ''}`,
            sourceLang: 'auto',
            metadata: { provider: 'mock' },
        };
    }

    /**
     * decide — deterministic structured decision for hermetic runs.
     * @why Lets the nexus → agent.decide → emit loop be tested offline. Picks the first
     *      allowed choice with high confidence so the inverted gate + emit gating can be
     *      asserted without a live LLM. Echoes a context key count into the reason so a
     *      test can confirm the assembled context reached the decision boundary.
     */
    async decide({ instruction, choices } = {}) {
        // Deterministic: pick the first allowed choice (inverted gate stays satisfiable),
        // echo the rendered instruction into `reason` — analogous to chat's MOCK_REPLY:: —
        // so a test can prove the assembled prompt (e.g. a fetched amount) reached the
        // decision boundary. confidence 0.9 ⇒ no escalate, so the emit branch fires.
        const decision = Array.isArray(choices) && choices.length ? choices[0] : 'ok';
        return {
            success: true,
            data: { decision, confidence: 0.9, reason: `MOCK_DECIDE::${instruction ?? ''}` },
            metadata: { provider: 'mock', model: 'mock-1', echo: true },
        };
    }

    /**
     * focus — deterministic slot-fill for hermetic runs.
     * @why Gives agent.focus an offline path (the real providers need live keys), so the
     *      multi-turn parameter-collection contract { extracted_params, confidence, hint,
     *      action } can be asserted in CI. Fills every missing field at full confidence and
     *      echoes the rendered input into `hint` (like chat's MOCK_REPLY:: / decide's
     *      MOCK_DECIDE::) so a test can prove the assembled focus prompt reached the provider.
     */
    async focus({ text, missingFields = [] } = {}) {
        const extracted_params = {};
        const confidence = {};
        for (const f of missingFields) {
            extracted_params[f] = `MOCK::${f}`;
            confidence[f] = 1;
        }
        return {
            extracted_params,
            confidence,
            hint: `MOCK_FOCUS::${text ?? ''}`,
            action: null,
            metadata: { provider: 'mock', model: 'mock-1', echo: true },
        };
    }
};
