const PromptBuilder = require('../../logic/prompt');
const { createLogger } = require('../../../../library/logger');
const { MODEL_CHAT, TEXT_API } = require('./constants');
const tokenLogger = require('../../lib/tokenLogger');

const logger = createLogger('agent');

module.exports = {
    async generateCases({ workflow, count, model }) {
        logger.info('[Qwen] Generating Test Cases...');
        const targetModel = model || MODEL_CHAT;
        const lang = this.config.language || 'zh';
        const prompt = PromptBuilder.buildCases(workflow, count, lang);

        try {
            const response = await this._callApi(TEXT_API, {
                input: { messages: [{ role: 'user', content: prompt }] },
                parameters: { result_format: 'message' }
            }, targetModel);

            const content = response.output?.choices?.[0]?.message?.content || '{}';
            logger.debug(`[Qwen] Cases Raw: ${content}`);

            if (response.usage) tokenLogger.log({ method: 'agent.case.generate', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                const result = JSON.parse(match[0]);
                return { success: true, workflow_id: result.workflow_id, cases: result.cases || [], prompt };
            }
            throw new Error('Invalid JSON output from Qwen');
        } catch (error) {
            if (error._isNetwork) throw error;
            logger.error('[Qwen] Generate Cases Error:', error.message);
            return { success: false, error: error.message };
        }
    },

    async suggestCategoryAttrs({ categoryPath, model }) {
        logger.info('[Qwen] Suggesting category attributes for:', categoryPath.join(' > '));
        const targetModel = model || MODEL_CHAT;
        const { system, user } = PromptBuilder.buildCategoryAttrSuggest(categoryPath);

        const response = await this._callApi(TEXT_API, {
            input: { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
            parameters: { result_format: 'message' }
        }, targetModel);

        if (!response.output?.choices) throw new Error('No output from Qwen');
        const text = response.output.choices[0].message.content.trim();
        if (response.usage) tokenLogger.log({ method: 'agent.category.suggest', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
        const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const attrs = JSON.parse(cleaned);
        if (!Array.isArray(attrs)) throw new Error('AI 返回格式错误');
        return attrs;
    },
};
