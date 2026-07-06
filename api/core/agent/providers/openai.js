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
            apiKey: config.openaiApiKey,
            baseURL: config.openaiBaseUrl // Delegate to custom endpoint
        });
    }

    // --- CORE LLM METHODS ---

    /**
     * Parses an image using an OpenAI-compatible vision model.
     * @param {object} options - { image, prompt, model }
     */
    async parseImage({ image, prompt, model }) {
        logger.info('[OpenAI] Parsing Image (Delegate)...');
        const targetModel = model || "gpt-4o"; // Placeholder default
        
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
        const targetModel = model || "whisper-1";
        
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
        const targetModel = model || "gpt-4o";
        
        try {
            const prompt = `
                Analyze the following text and extract information according to this schema:
                ${JSON.stringify(schema, null, 2)}
                
                Text: "${text}"
                
                Return ONLY valid JSON.
            `;

            const response = await this.client.chat.completions.create({
                model: targetModel,
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            });

            const output = response.choices[0].message.content;
            return {
                success: true,
                data: JSON.parse(output),
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
        const targetModel = model || "gpt-4o";
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
        const targetModel = model || "gpt-4o";
        const PromptBuilder = require('../logic/prompt');
        const { system, user } = PromptBuilder.buildCategoryAttrSuggest(categoryPath);
        
        try {
            const response = await this.client.chat.completions.create({
                model: targetModel,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user }
                ],
                response_format: { type: "json_object" }
            });

            const text = response.choices[0].message.content.trim();
            const attrs = JSON.parse(text);
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
        const targetModel = model || 'gpt-4o-mini';
        const PromptBuilder = require('../logic/prompt');
        const prompt = PromptBuilder.buildDecide({ instruction, context, choices, schema });
        try {
            const response = await this.client.chat.completions.create({
                model: targetModel,
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' },
                temperature: 0,
            });
            const data = JSON.parse(response.choices[0].message.content);
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
