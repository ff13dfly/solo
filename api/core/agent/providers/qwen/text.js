const PromptBuilder = require('../../logic/prompt');
const { createLogger } = require('../../../../library/logger');
const { MODEL_CHAT, TEXT_API } = require('./constants');
const tokenLogger = require('../../lib/tokenLogger');

const logger = createLogger('agent');

module.exports = {
    async chat({ text, history, model }) {
        logger.info('[Qwen] Chat...');
        const targetModel = model || MODEL_CHAT;
        const lang = this.config.language || 'zh';
        const messages = [];

        if (history && Array.isArray(history) && history.length > 0) {
            messages.push(...history);
            messages.push({ role: 'user', content: text });
        } else {
            const fullPrompt = PromptBuilder.buildChat(text, this.config, lang);
            messages.push({ role: 'user', content: fullPrompt });
        }

        try {
            const response = await this._callApi(TEXT_API, {
                input: { messages },
                parameters: { result_format: 'message' }
            }, targetModel);

            if (response.output?.choices) {
                const content = response.output.choices[0].message.content;
                if (response.usage) tokenLogger.log({ method: 'agent.chat', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
                return { success: true, text: content, metadata: { provider: 'qwen', model: targetModel, request_id: response.request_id } };
            }
            throw new Error('No output from Qwen Chat');
        } catch (error) {
            if (error._isNetwork) { logger.warn('[Qwen] Chat Network Error (Will retry):', error.message); throw error; }
            logger.error('[Qwen] Chat Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'qwen', model: targetModel } };
        }
    },

    async productInquiry({ text, productContext, lang, model }) {
        logger.info('[Qwen] Product Inquiry...');
        const targetModel = model || MODEL_CHAT;
        const targetLang = lang || this.config.language || 'zh';
        const fullPrompt = PromptBuilder.buildProductInquiry(text, productContext, this.config, targetLang);

        try {
            const response = await this._callApi(TEXT_API, {
                input: { messages: [{ role: 'user', content: fullPrompt }] },
                parameters: { result_format: 'message' }
            }, targetModel);

            if (response.output?.choices) {
                const content = response.output.choices[0].message.content;
                if (response.usage) tokenLogger.log({ method: 'agent.text.inquiry', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
                return { success: true, text: content, metadata: { provider: 'qwen', model: targetModel, request_id: response.request_id } };
            }
            throw new Error('No output from Qwen Product Inquiry');
        } catch (error) {
            if (error._isNetwork) { logger.warn('[Qwen] Product Inquiry Network Error (Will retry):', error.message); throw error; }
            logger.error('[Qwen] Product Inquiry Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'qwen', model: targetModel } };
        }
    },

    async parseText({ text, schema, model }) {
        logger.info('[Qwen] Parsing Text...');
        const targetModel = model || MODEL_CHAT;
        try {
            const response = await this._callApi(TEXT_API, {
                input: {
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant that outputs JSON.' },
                        { role: 'user', content: text }
                    ]
                },
                parameters: { result_format: 'message' }
            }, targetModel);

            if (response.output?.choices) {
                const content = response.output.choices[0].message.content;
                let data = content;
                try { if (schema) data = JSON.parse(content); } catch (e) { }
                if (response.usage) tokenLogger.log({ method: 'agent.text.parse', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
                return { success: true, data, metadata: { provider: 'qwen', model: targetModel } };
            }
            throw new Error('No output from Qwen parseText');
        } catch (error) {
            if (error._isNetwork) { logger.warn('[Qwen] Text Network Error (Will retry):', error.message); throw error; }
            logger.error('[Qwen] Text Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'qwen', model: targetModel } };
        }
    },

    async translateText({ text, targetLang, sourceLang, context, model }) {
        logger.info(`[Qwen] Translating to ${targetLang}...`);
        const targetModel = model || MODEL_CHAT;
        const prompt = `Translate the following text to ${targetLang}.
${sourceLang ? `Source language: ${sourceLang}` : 'Auto-detect the source language.'}
${context ? `Context: ${context}` : ''}

Product-specific rules:
1. Maintain technical terms and brand names if appropriate.
2. Use professional, business-appropriate tone.

Text to translate:
"${text}"

Return ONLY the translated text, no explanation.`;

        try {
            const response = await this._callApi(TEXT_API, {
                input: { messages: [{ role: 'user', content: prompt }] },
                parameters: { result_format: 'message' }
            }, targetModel);

            if (response.output?.choices) {
                const translatedText = response.output.choices[0].message.content.trim();
                if (response.usage) tokenLogger.log({ method: 'agent.text.translate', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
                return { success: true, translatedText, sourceLang: sourceLang || 'auto', metadata: { provider: 'qwen', model: targetModel, request_id: response.request_id } };
            }
            throw new Error('No output from Qwen Translation');
        } catch (error) {
            logger.error('[Qwen] Translation Error:', error.message);
            throw error;
        }
    },

    /**
     * decide — structured decision via DashScope text-generation.
     * @why Backs agent.decide. Returns parsed JSON ({ decision, confidence, reason, fields? });
     *      the logic layer enforces the inverted gate + degradability. Re-throws network
     *      errors (so retry/escalate can see them); returns { success:false } otherwise.
     */
    async decide({ instruction, context, choices, schema, model }) {
        logger.info('[Qwen] Decide...');
        const targetModel = model || MODEL_CHAT;
        const prompt = PromptBuilder.buildDecide({ instruction, context, choices, schema });
        try {
            const response = await this._callApi(TEXT_API, {
                input: {
                    messages: [
                        { role: 'system', content: 'You are a decision engine that outputs ONLY a single JSON object.' },
                        { role: 'user', content: prompt },
                    ],
                },
                parameters: { result_format: 'message', temperature: 0 },
            }, targetModel);

            if (!response.output?.choices) throw new Error('No output from Qwen decide');
            const content = response.output.choices[0].message.content;
            if (response.usage) tokenLogger.log({ method: 'agent.decide', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
            const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            const match = cleaned.match(/\{[\s\S]*\}/);
            const data = JSON.parse(match ? match[0] : cleaned);
            return { success: true, data, metadata: { provider: 'qwen', model: targetModel } };
        } catch (error) {
            if (error._isNetwork) { logger.warn('[Qwen] Decide Network Error:', error.message); throw error; }
            logger.error('[Qwen] Decide Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'qwen', model: targetModel } };
        }
    },
};
