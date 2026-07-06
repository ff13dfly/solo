/**
 * LLM Provider Factory
 * 
 * @why Decouples the Agent logic from specific AI vendors (Google, OpenAI, Alibaba).
 *      Allows for easy switching of models and providers based on cost or performance.
 */

// --- PROVIDER REGISTRY ---

// Providers will be lazy-loaded 
// const GeminiProvider = require('./gemini');
// const OpenAIProvider = require('./openai');
// const QwenProvider = require('./qwen');
const { createLogger } = require('../../../library/logger');

const logger = createLogger('agent');

class ProviderFactory {
    static instances = {};

    static getProvider(config, model) {
        let type = config.provider || 'gemini';

        // A forced provider (e.g. AI_PROVIDER=mock for offline/hermetic runs) wins over
        // model-name auto-detection — modelConfig.resolve() still returns a real model
        // name like 'gemini-1.5-flash', which must NOT override the forced provider.
        const forced = type === 'mock';

        // Auto-detect provider from model name if provided.
        // Bitexing check must come BEFORE generic 'gemini' check because Bitexing
        // model names like "gemini-3.1-flash-image-preview" contain "gemini".
        if (!forced && model) {
            if (model.startsWith('qwen')) type = 'qwen';
            else if (model.includes('gemini')) type = 'gemini';
            else if (model.startsWith('gpt') || model.includes('openai')) type = 'openai';
            else if (model === 'bitexing') type = 'bitexing';
            else if (model.startsWith('mock')) type = 'mock';
        }

        if (!this.instances[type]) {
            switch (type.toLowerCase()) {
                case 'mock':
                    const MockProvider = require('./mock');
                    this.instances[type] = new MockProvider(config);
                    break;
                case 'gemini':
                    const GeminiProvider = require('./gemini');
                    this.instances[type] = new GeminiProvider({ ...config, language: config.agents.gemini.language });
                    break;
                case 'openai':
                    const OpenAIProvider = require('./openai');
                    this.instances[type] = new OpenAIProvider({ ...config, language: config.agents.openai.language });
                    break;
                case 'bitexing':
                    const BitexingProvider = require('./bitexing');
                    this.instances[type] = new BitexingProvider({ ...config, language: config.agents.bitexing.language });
                    break;
                case 'qwen':
                    const QwenProvider = require('./qwen');
                    this.instances[type] = new QwenProvider({ ...config, language: config.agents.qwen.language });
                    break;
                default:
                    logger.warn(`Unknown provider ${type}, falling back to Gemini`);
                    const GeminiFallback = require('./gemini');
                    this.instances[type] = new GeminiFallback({ ...config, language: config.agents.gemini.language });
            }
        }
        return this.instances[type];
    }
}

module.exports = ProviderFactory;
