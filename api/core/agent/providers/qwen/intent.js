const PromptBuilder = require('../../logic/prompt');
const { createLogger } = require('../../../../library/logger');
const { MODEL_CHAT, TEXT_API } = require('./constants');
const tokenLogger = require('../../lib/tokenLogger');

const logger = createLogger('agent');

module.exports = {
    async identifyPurpose({ text, capabilities, model, noWorkflow }) {
        logger.info(`[Qwen] Identify Purpose (Legacy Fallback)${noWorkflow ? ' [noWorkflow]' : ''}...`);

        const selectedCaps = (capabilities || []).filter(cap => {
            if (noWorkflow && cap.type === 'workflow') return false;
            return true;
        });

        const formattedCapabilities = selectedCaps.map(cap => {
            if (typeof cap === 'string') return cap;
            if (cap.type === 'workflow') return `- [ID: ${cap.id}] [工作流名称: ${cap.name}]: ${cap.desc || ''}`;
            return `- [ID: ${cap.name || cap.id}] [描述]: ${cap.desc || cap.description || ''}`;
        });

        const context = { candidates: formattedCapabilities, workflows: [] };

        const result = await this.identifyPurposeWithContext({ text, phase: 2, context, model, noWorkflow });

        if (result.candidates && result.candidates.length > 0) {
            const best = result.candidates[0];
            if (best.id && best.id !== 'null') return best;
        }
        return { id: 'agent.chat' };
    },

    async identifyPurposeWithContext({ text, memory = '', phase, context, model, noWorkflow }) {
        if (noWorkflow && context.candidates) {
            context.candidates = context.candidates.filter(cap => !cap.includes('[工作流名称:'));
        }
        logger.info(`[Qwen] Purpose Detection - Phase ${phase}${noWorkflow ? ' [noWorkflow]' : ''}${memory ? ' [with Memory]' : ''}`);
        const targetModel = model || MODEL_CHAT;
        const lang = this.config.language || 'zh';

        if (phase === 1) {
            const prompt = PromptBuilder.buildPhase1(text, context, lang, memory);
            try {
                const response = await this._callApi(TEXT_API, {
                    input: { messages: [{ role: 'user', content: prompt }] },
                    parameters: { result_format: 'message' }
                }, targetModel);
                const content = response.output?.choices?.[0]?.message?.content || '{}';
                logger.debug(`[Qwen] Phase 1 Raw: ${content}`);
                if (response.usage) tokenLogger.log({ method: 'agent.purpose', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    const result = JSON.parse(match[0]);
                    return { services: result.services || [], categories: result.categories || [] };
                }
            } catch (e) {
                if (e._isNetwork) throw e;
                logger.error('[Qwen] Phase 1 Error:', e.message);
            }
            return { services: [], categories: [] };
        } else if (phase === 2) {
            const prompt = PromptBuilder.buildPhase2(text, context, lang, memory);
            const systemPrompt = this.config.systemPrompts[lang] || this.config.systemPrompts['en'];
            try {
                const response = await this._callApi(TEXT_API, {
                    input: {
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: prompt }
                        ]
                    },
                    parameters: { result_format: 'message' }
                }, targetModel);
                const content = response.output?.choices?.[0]?.message?.content || '{}';
                logger.debug(`[Qwen] Phase 2 Raw: ${content}`);
                if (response.usage) tokenLogger.log({ method: 'agent.purpose', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    const result = JSON.parse(match[0]);
                    if (result.candidates && Array.isArray(result.candidates)) {
                        return { candidates: result.candidates };
                    } else if (result.selected) {
                        return { candidates: [{ ...result.selected, params: result.params, missingParams: result.missingParams }] };
                    }
                }
            } catch (e) {
                if (e._isNetwork) throw e;
                logger.error('[Qwen] Phase 2 Error:', e.message);
                return { candidates: [{ id: 'agent.error', error: e.message }] };
            }
            return { candidates: [] };
        }
        throw new Error('Invalid phase parameter. Must be 1 or 2.');
    },

    async focus({ text, memory = '', workflow, currentParams, missingFields, model }) {
        logger.info(`[Qwen] Focus - Parameter Extraction${memory ? ' [with Memory]' : ''}`);
        const targetModel = model || MODEL_CHAT;
        const lang = this.config.language || 'zh';

        const now = new Date();
        const beijingOffset = 8 * 60 * 60 * 1000;
        const beijingNow = new Date(now.getTime() + beijingOffset);
        const currentHour = beijingNow.getUTCHours();
        const currentMinute = beijingNow.getUTCMinutes();
        const todayDate = beijingNow.toISOString().split('T')[0];
        const tomorrowDate = new Date(beijingNow.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
        const timeContext = `现在北京时间 ${todayDate} ${currentTimeStr}。今天日期=${todayDate}，明天日期=${tomorrowDate}。重要规则：如果用户提到的时间点早于 ${currentTimeStr}（说明今天该时间已过），请务必使用明天的日期 ${tomorrowDate}。例如：现在是${currentTimeStr}，用户说"早上8点"，因为8点早于${currentTimeStr}，所以是指明天。`;

        logger.debug(`[Qwen] Time Context: ${timeContext}`);

        const prompt = PromptBuilder.buildFocus(text, { workflow, currentParams, missingFields, currentTime: timeContext, memory }, lang);
        logger.debug(`[Qwen] Focus Prompt (first 500 chars): ${prompt.substring(0, 500)}...`);

        try {
            const response = await this._callApi(TEXT_API, {
                input: { messages: [{ role: 'user', content: prompt }] },
                // json-mode: DashScope returns a bare JSON object instead of prose-wrapped
                // JSON, so the regex extraction below stops missing it. Purely additive —
                // the match()/parse fallback stays as a safety net if a model ignores the flag.
                parameters: { result_format: 'message', response_format: { type: 'json_object' } }
            }, targetModel);

            const content = response.output?.choices?.[0]?.message?.content || '{}';
            logger.debug(`[Qwen] Focus Raw: ${content}`);
            if (response.usage) tokenLogger.log({ method: 'agent.focus', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });

            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                const result = JSON.parse(match[0]);
                return {
                    extracted_params: result.extracted_params || {},
                    confidence: result.confidence || {},
                    hint: result.hint || '',
                    action: result.action || null,
                    clarification: result.clarification || null
                };
            }
            return { extracted_params: {}, confidence: {}, hint: '抱歉，我没能理解您的意思。请再说一遍？', action: null };
        } catch (e) {
            if (e._isNetwork) throw e;
            logger.error('[Qwen] Focus Error:', e.message);
            const isLocalNetworkError = e.message && (
                e.message.includes('network') || e.message.includes('socket') ||
                e.message.includes('ECONNREFUSED') || e.message.includes('ETIMEDOUT') ||
                e.message.includes('TLS') || e.message.includes('fetch')
            );
            return {
                extracted_params: {}, confidence: {},
                hint: isLocalNetworkError ? '网络连接出现问题，请稍后再试~ 🔄' : '抱歉，处理时遇到了问题。请再说一遍？',
                action: null
            };
        }
    },
};
