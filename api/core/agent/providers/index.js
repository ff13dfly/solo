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

    /**
     * Resolve provider type from config and model identifier.
     *
     * Priority:
     *   1. `config.provider === 'mock'` (hermetic test lock — always wins).
     *   2. Explicit namespace prefix on `model`:
     *      `solo-peer/<model>`, `ollama/<model>`, `openai/<model>`,
     *      `qwen/<model>`, `gemini/<model>`, `bitexing/<model>`, `mock/<model>`
     *      (also accepts `<provider>:<model>` when `<provider>` is an exact provider id).
     *   3. Explicit `config.provider === 'ollama'` or `'solo-peer'` when `model` is bare
     *      or uses an Ollama tag (`qwen3.5:9b`, `llama3.2:latest`, etc.).
     *   4. Legacy bare model-name auto-detection (`qwen-*`, `gemini-*`, `gpt-*`, `bitexing`, `mock*`).
     */
    static resolveProviderType(config = {}, model = '') {
        const defaultType = String(config.provider || 'gemini').toLowerCase();
        if (defaultType === 'mock') return 'mock';

        const rawModel = String(model || '').trim();
        if (rawModel) {
            const prefixMatch = rawModel.match(/^(solo-peer|ollama|openai|qwen|gemini|bitexing|mock)[/:](.+)$/i);
            if (prefixMatch) {
                return prefixMatch[1].toLowerCase();
            }
            const exactProvider = rawModel.toLowerCase();
            if (['solo-peer', 'ollama', 'openai', 'qwen', 'gemini', 'bitexing', 'mock'].includes(exactProvider)) {
                return exactProvider;
            }
        }

        // If AI_PROVIDER is explicitly set to 'ollama' or 'solo-peer', keep it unless
        // the caller explicitly passed a cloud namespace prefix above.
        if (defaultType === 'ollama' || defaultType === 'solo-peer') {
            return defaultType;
        }

        if (rawModel) {
            // Bare Ollama tag syntax like `qwen3.5:9b` or `deepseek-r1:8b` (colon tag)
            if (/^[a-z0-9._-]+:[a-z0-9._-]+$/i.test(rawModel)) {
                return 'ollama';
            }
            if (rawModel.startsWith('qwen')) return 'qwen';
            if (rawModel.includes('gemini')) return 'gemini';
            if (rawModel.startsWith('gpt') || rawModel.includes('openai')) return 'openai';
            if (rawModel === 'bitexing') return 'bitexing';
            if (rawModel.startsWith('mock')) return 'mock';
        }

        return defaultType;
    }

    static getProvider(config, model) {
        const type = this.resolveProviderType(config, model);
        const agentsCfg = (config && config.agents) || {};

        if (!this.instances[type]) {
            switch (type.toLowerCase()) {
                case 'mock': {
                    const MockProvider = require('./mock');
                    this.instances[type] = new MockProvider(config);
                    break;
                }
                case 'ollama': {
                    const OllamaProvider = require('./ollama');
                    this.instances[type] = new OllamaProvider({
                        ...config,
                        language: agentsCfg.ollama?.language || 'zh',
                    });
                    break;
                }
                case 'solo-peer': {
                    const SoloPeerProvider = require('./solo-peer');
                    this.instances[type] = new SoloPeerProvider({
                        ...config,
                        language: agentsCfg['solo-peer']?.language || 'zh',
                    });
                    break;
                }
                case 'gemini': {
                    const GeminiProvider = require('./gemini');
                    this.instances[type] = new GeminiProvider({
                        ...config,
                        language: agentsCfg.gemini?.language || 'en',
                    });
                    break;
                }
                case 'openai': {
                    const OpenAIProvider = require('./openai');
                    this.instances[type] = new OpenAIProvider({
                        ...config,
                        language: agentsCfg.openai?.language || 'en',
                    });
                    break;
                }
                case 'bitexing': {
                    const BitexingProvider = require('./bitexing');
                    this.instances[type] = new BitexingProvider({
                        ...config,
                        language: agentsCfg.bitexing?.language || 'zh',
                    });
                    break;
                }
                case 'qwen': {
                    const QwenProvider = require('./qwen');
                    this.instances[type] = new QwenProvider({
                        ...config,
                        language: agentsCfg.qwen?.language || 'zh',
                    });
                    break;
                }
                default: {
                    logger.warn(`Unknown provider ${type}, falling back to Gemini`);
                    const GeminiFallback = require('./gemini');
                    this.instances[type] = new GeminiFallback({
                        ...config,
                        language: agentsCfg.gemini?.language || 'en',
                    });
                }
            }
        }
        return this.instances[type];
    }
}

module.exports = ProviderFactory;
