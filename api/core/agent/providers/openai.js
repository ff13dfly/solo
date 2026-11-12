const OpenAI = require('openai');
const { createLogger } = require('../../../library/logger');
const logger = createLogger('agent');

/**
 * OpenAI Provider
 * @why Implements Agent reasoning using OpenAI-compatible models (including Gemini via proxies).
 * @attention This provider acts as a Delegate to external endpoints.
 */
class OpenAIProvider {
    // --- INITIALIZATION ---
    constructor(config) {
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.openaiApiKey || 'sk-placeholder',
            baseURL: config.openaiBaseUrl // Delegate to custom endpoint
        });
    }

    _resolveModel(model, fallback = 'gpt-4o') {
        const raw = String(model || '').trim();
        if (!raw || raw.toLowerCase() === 'openai') return fallback;
        return raw.replace(/^openai[/:]/i, '').trim() || fallback;
    }

    _useJsonMode() {
        if (typeof this.config?.openaiJsonMode === 'boolean') {
            return this.config.openaiJsonMode;
        }
        return process.env.OPENAI_JSON_MODE !== 'false';
    }

    // --- CORE LLM METHODS ---

    /**
     * Parses an image using an OpenAI-compatible vision model.
     * @param {object} options - { image, prompt, model }
     */
    async parseImage({ image, prompt, model }) {
        logger.info('[OpenAI] Parsing Image (Delegate)...');
        const targetModel = this._resolveModel(model, "gpt-4o"); // Placeholder default
        
        try {
            const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
            
            const response = await this.client.chat.completions.create({
                model: targetModel,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt || "Describe this image" },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Data}`,
                                },
                            },
                        ],
                    },
                ],
            });

            const text = response.choices[0].message.content;

            // Try to extract JSON if requested
            try {
                const match = text.match(/\{[\s\S]*\}/);
                if (match) {
                    return {
                        success: true,
                        data: JSON.parse(match[0]),
                        metadata: { provider: 'openai', model: targetModel }
                    };
                }
            } catch (e) {
                // Return as text if JSON parsing fails
            }

            return {
                success: true,
                data: { text },
                metadata: { provider: 'openai', model: targetModel }
            };
        } catch (error) {
            logger.error('[OpenAI] Image Error:', error);
            throw error;
        }
    }

    async transcribeAudio({ audio, model }) {
        logger.info('[OpenAI] Transcribing Audio (Delegate)...');
        const targetModel = this._resolveModel(model, "whisper-1");
        
        try {
            // Placeholder: Most proxies handle audio via specialized endpoints
            // Here we assume standard OpenAI structure if supported
            return {
                success: false,
                error: "Audio transcription over delegate not yet optimized. Check proxy compatibility.",
                metadata: { provider: 'openai', model: targetModel }
            };
        } catch (error) {
            logger.error('[OpenAI] Audio Error:', error);
            throw error;
        }
    }

    async parseText({ text, schema, model }) {
        logger.info('[OpenAI] Parsing Text (Delegate)...');
        const targetModel = this._resolveModel(model, "gpt-4o");
        
        try {
            const prompt = `
                Analyze the following text and extract information according to this schema:
                ${JSON.stringify(schema, null, 2)}
                
                Text: "${text}"
                
                Return ONLY valid JSON.
            `;

            const reqPayload = {
                model: targetModel,
                messages: [{ role: "user", content: prompt }],
            };
            if (this._useJsonMode()) {
                reqPayload.response_format = { type: "json_object" };
            }
            const response = await this.client.chat.completions.create(reqPayload);

            const output = response.choices[0].message.content;
            const cleaned = String(output || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
            return {
                success: true,
                data: JSON.parse(cleaned),
                metadata: { provider: 'openai', model: targetModel }
            };
        } catch (error) {
            logger.error('[OpenAI] Text Error:', error);
            throw error;
        }
    }

    async chat(params) {
        const { text, model } = params;
        logger.info('[OpenAI] Chatting (Delegate)...');
        const targetModel = this._resolveModel(model, "gpt-4o");
        const lang = this.config.language || 'en';
        const PromptBuilder = require('../logic/prompt');

        try {
            const prompt = PromptBuilder.buildChat(text, this.config, lang);
            const response = await this.client.chat.completions.create({
                model: targetModel,
                messages: [{ role: "user", content: prompt }]
            });

            return {
                success: true,
                text: response.choices[0].message.content,
                metadata: { provider: 'openai', model: targetModel }
            };
        } catch (error) {
            logger.error('[OpenAI] Chat Error:', error);
            throw error;
        }
    }

    async suggestCategoryAttrs({ categoryPath, model }) {
        logger.info('[OpenAI] Suggesting category attributes (Delegate):', categoryPath.join(' > '));
        const targetModel = this._resolveModel(model, "gpt-4o");
        const PromptBuilder = require('../logic/prompt');
        const { system, user } = PromptBuilder.buildCategoryAttrSuggest(categoryPath);
        
        try {
            const reqPayload = {
                model: targetModel,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user }
                ],
            };
            if (this._useJsonMode()) {
                reqPayload.response_format = { type: "json_object" };
            }
            const response = await this.client.chat.completions.create(reqPayload);

            const text = response.choices[0].message.content.trim();
            const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
            const attrs = JSON.parse(cleaned);
            return attrs;
        } catch (error) {
            logger.error('[OpenAI] Suggest Error:', error);
            throw error;
        }
    }

    /**
     * decide — structured decision via OpenAI-compatible JSON mode.
     * @why Backs agent.decide. Returns parsed JSON; logic layer enforces the inverted
     *      gate + degradability. Returns { success:false } on error so callers fail-soft.
     */
    async decide({ instruction, context, choices, schema, model }) {
        logger.info('[OpenAI] Decide (Delegate)...');
        const targetModel = this._resolveModel(model, 'gpt-4o-mini');
        const PromptBuilder = require('../logic/prompt');
        const prompt = PromptBuilder.buildDecide({ instruction, context, choices, schema });
        try {
            const reqPayload = {
                model: targetModel,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0,
            };
            if (this._useJsonMode()) {
                reqPayload.response_format = { type: 'json_object' };
            }
            const response = await this.client.chat.completions.create(reqPayload);
            const rawContent = String(response.choices[0].message.content || '')
                .replace(/```(?:json)?\s*/gi, '')
                .replace(/```/g, '')
                .trim();
            const data = JSON.parse(rawContent);
            return { success: true, data, metadata: { provider: 'openai', model: targetModel } };
        } catch (error) {
            logger.error('[OpenAI] Decide Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'openai', model: targetModel } };
        }
    }

    /**
     * Placeholder for required agent methods
     */
    async identifyPurposeWithContext() { throw new Error("Method not implemented for OpenAI Delegate yet."); }
    async identifyPurpose() { throw new Error("Method not implemented for OpenAI Delegate yet."); }
    async focus() { throw new Error("Method not implemented for OpenAI Delegate yet."); }
}

module.exports = OpenAIProvider;
