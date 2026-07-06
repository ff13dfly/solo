const OpenAI = require('openai');
const axios = require('axios');
const { createLogger } = require('../../../library/logger');
const logger = createLogger('agent');

/**
 * Bitexing Provider
 * @why Implements Agent reasoning using the Bitexing AI proxy for Gemini.
 * @attention This is a dedicated provider for the bitexingai.com gateway.
 */
class BitexingProvider {
    // --- INITIALIZATION ---
    constructor(config) {
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.bitexingApiKey,
            baseURL: config.bitexingBaseUrl
        });
        // Default model for Bitexing is Gemini (Banana)
        this.defaultModel = "gemini-3.1-flash-image-preview";
    }

    // --- CORE LLM METHODS ---

    async parseImage({ image, prompt, model }) {
        logger.info('[Bitexing] Parsing Image (Banana)...');
        const targetModel = model || this.defaultModel;
        
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

            try {
                const match = text.match(/\{[\s\S]*\}/);
                if (match) {
                    return {
                        success: true,
                        data: JSON.parse(match[0]),
                        metadata: { provider: 'bitexing', model: targetModel }
                    };
                }
            } catch (e) { }

            return {
                success: true,
                data: { text },
                metadata: { provider: 'bitexing', model: targetModel }
            };
        } catch (error) {
            logger.error('[Bitexing] Image Error:', error);
            throw error;
        }
    }

    async psImage({ image, mask, prompt, model }) {
        logger.info('[Bitexing] Processing PS (Axios Native)...');
        const targetModel = model || "gemini-3.1-flash-image-preview";
        
        try {
            const formData = new FormData();
            
            // Convert base64 to Blob for FormData
            const imgBuffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ""), 'base64');
            const imgBlob = new Blob([imgBuffer], { type: 'image/jpeg' });
            formData.append('image', imgBlob, 'image.jpg');
            
            if (mask) {
                const maskBuffer = Buffer.from(mask.replace(/^data:image\/\w+;base64,/, ""), 'base64');
                const maskBlob = new Blob([maskBuffer], { type: 'image/png' });
                formData.append('mask', maskBlob, 'mask.png');
            }
            
            formData.append('prompt', prompt || "Background replacement");
            formData.append('model', targetModel);
            formData.append('response_format', 'b64_json');

            const response = await axios.post(`${this.config.bitexingBaseUrl}/images/edits`, formData, {
                headers: {
                    'Authorization': `Bearer ${this.config.bitexingApiKey}`,
                    ...formData.headers // Modern Node handles this automatically, but extra safety
                }
            });

            return {
                success: true,
                image: response.data.data[0].b64_json,
                metadata: { provider: 'bitexing', model: targetModel }
            };
        } catch (error) {
            const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
            logger.error('[Bitexing] PS Axios Error:', errorMsg);
            throw new Error(errorMsg);
        }
    }

    async parseText({ text, schema, model }) {
        logger.info('[Bitexing] Parsing Text...');
        const targetModel = model || this.defaultModel;
        
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
                metadata: { provider: 'bitexing', model: targetModel }
            };
        } catch (error) {
            logger.error('[Bitexing] Text Error:', error);
            throw error;
        }
    }

    async chat(params) {
        const { text, model } = params;
        logger.info('[Bitexing] Chatting...');
        const targetModel = model || this.defaultModel;
        const lang = this.config.language || 'zh';
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
                metadata: { provider: 'bitexing', model: targetModel }
            };
        } catch (error) {
            logger.error('[Bitexing] Chat Error:', error);
            throw error;
        }
    }

    async suggestCategoryAttrs({ categoryPath, model }) {
        logger.info('[Bitexing] Suggesting attributes:', categoryPath.join(' > '));
        const targetModel = model || this.defaultModel;
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
            logger.error('[Bitexing] Suggest Error:', error);
            throw error;
        }
    }

    // Required placeholders
    async transcribeAudio() { throw new Error("Audio not implemented for Bitexing yet."); }
    async identifyPurposeWithContext() { throw new Error("Method not implemented for Bitexing."); }
    async identifyPurpose() { throw new Error("Method not implemented for Bitexing."); }
    async focus() { throw new Error("Method not implemented for Bitexing."); }
}

module.exports = BitexingProvider;
