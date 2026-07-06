const config = require('../config');
const chalk = require('chalk');
const jsonrpc = require('../handlers/jsonrpc');
const ProviderFactory = require('../providers');
const modelConfig = require('./model_config');
const decideLogic = require('./decide');
const { createLogger } = require('../../../library/logger');

const logger = createLogger(config.serviceName || 'agent');

// --- AGENT LOGIC ENTRY ---

/**
 * Agent Logic Registry
 * @why Centralizes all AI capabilities (Chat, Purpose, Focus, etc.) and handles 
 *      resilience through automatic retries for network-related LLM failures.
 */

// --- RESILIENCE & RETRY LOGIC ---

/**
 * isNetworkError
 * @why Identifies errors that are likely transient (e.g., rate limits, TLS issues).
 */
function isNetworkError(error) {
    const networkPatterns = [
        'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND',
        'socket disconnected', 'socket hang up', 'network',
        'TLS', 'SSL', 'connection', 'timeout', 'fetch', 'undici'
    ];
    const msg = (error.message || '').toLowerCase();
    const code = (error.code || '').toString().toLowerCase();

    return networkPatterns.some(p =>
        msg.includes(p.toLowerCase()) || code.includes(p.toLowerCase())
    );
}

/**
 * withRetryableError
 * @why Wraps expensive LLM calls to provide a standardized, retryable error format to the frontend.
 * @process Catches network errors and re-throws with `retryable: true` metadata.
 */
async function withRetryableError(fn, methodName) {
    try {
        return await fn();
    } catch (error) {
        if (isNetworkError(error)) {
            logger.error(`Network error in ${methodName}: ${error.message}`);
            throw jsonrpc.RETRY_LATER(null, {
                retryable: true,
                retryAfter: 3000,
                originalError: error.message
            });
        }
        throw error;
    }
}

// --- CORE AI CAPABILITIES ---

const methods = {
    agent: {
        image: {
            parse: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('image.parse', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    if (params.mode === 'product') {
                        return await provider.extractProductInfo({ ...params, model });
                    }
                    return await provider.parseImage({ ...params, model });
                }, 'agent.image.parse');
            },
            ps: async (params) => {
                return withRetryableError(async () => {
                    if (config.removeBgApiKey && !params.model) {
                        const RemoveBgProvider = require('../providers/removebg');
                        const rbg = new RemoveBgProvider(config);
                        return await rbg.psImage(params);
                    }
                    const model = await modelConfig.resolve('image.ps', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    return await provider.psImage({ ...params, model });
                }, 'agent.image.ps');
            },
            classify: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('image.classify', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    return await provider.classifyImage({ ...params, model });
                }, 'agent.image.classify');
            },
            generate: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('image.generate', params.model);
                    const provider = ProviderFactory.getProvider(config, model || 'gemini');
                    return await provider.generateImage({ ...params, model });
                }, 'agent.image.generate');
            },
            process: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('image.process', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    return await provider.processImage({ ...params, model });
                }, 'agent.image.process');
            }
        },
        label: {
            scan: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('label.scan', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    return await provider.scanLabel({ ...params, model });
                }, 'agent.label.scan');
            }
        },
        audio: {
            transcribe: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('audio.transcribe', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    return await provider.transcribeAudio({ ...params, model });
                }, 'agent.audio.transcribe');
            }
        },
        text: {
            parse: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('text.parse', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    return await provider.parseText({ ...params, model });
                }, 'agent.text.parse');
            },
            translate: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('text.translate', params.model);
                    const provider = ProviderFactory.getProvider(config, model);
                    return await provider.translateText({ ...params, model });
                }, 'agent.text.translate');
            }
        },
        /**
         * agent.purpose
         * @why Identifies what the user wants to do (Intent Detection).
         * @process 
         *   1. Resolves system capabilities.
         *   2. Hands over to the LLM provider for zero-shot or context-aware matching.
         */
        purpose: async (params) => {
            return withRetryableError(async () => {
                const model = await modelConfig.resolve('agent.purpose', params.model);
                const provider = ProviderFactory.getProvider(config, model);

                // Frontend-driven Two-Step Matching
                if (params.phase && params.context) {
                    return await provider.identifyPurposeWithContext({
                        text: params.text,
                        memory: params.memory || '',
                        phase: params.phase,
                        context: params.context,
                        model,
                        noWorkflow: params.noWorkflow
                    });
                }

                // Legacy mode
                const CapabilityManager = require('./capability');
                const systemCapabilities = await CapabilityManager.getCapabilities();

                return await provider.identifyPurpose({
                    text: params.text,
                    image: params.image,
                    memory: params.memory || '',
                    capabilities: systemCapabilities,
                    model,
                    noWorkflow: params.noWorkflow
                });
            }, 'agent.purpose');
        },
        chat: async (params) => {
            return withRetryableError(async () => {
                const model = await modelConfig.resolve('agent.chat', params.model);
                const provider = ProviderFactory.getProvider(config, model);
                return await provider.chat({ ...params, model });
            }, 'agent.chat');
        },
        focus: async (params) => {
            return withRetryableError(async () => {
                const model = await modelConfig.resolve('agent.focus', params.model);
                const provider = ProviderFactory.getProvider(config, model);

                if (!params.workflow_id || !params.user_input) {
                    throw jsonrpc.INTERNAL_ERROR('Missing required params: workflow_id, user_input');
                }

                const CapabilityManager = require('./capability');
                const allCapabilities = await CapabilityManager.getCapabilities();
                const cachedWf = allCapabilities.find(w => w.id === params.workflow_id || w.name === params.workflow_id);

                const workflow = {
                    id: params.workflow_id,
                    name: params.workflow_name || params.workflow_id,
                    desc: params.workflow_desc || '',
                    synonyms: params.synonyms || {},
                    required_inputs: params.required_inputs || [],
                    params: cachedWf ? cachedWf.params : [],
                    ai_meta: cachedWf ? cachedWf.ai_meta : undefined
                };

                return await provider.focus({
                    text: params.user_input,
                    memory: params.memory || '',
                    workflow,
                    currentParams: params.current_params || {},
                    missingFields: params.missing_fields || [],
                    model
                });
            }, 'agent.focus');
        },
        case: {
            generate: async (params) => {
                return withRetryableError(async () => {
                    const model = await modelConfig.resolve('agent.case.generate', params.model);
                    const provider = ProviderFactory.getProvider(config, model);

                    const CapabilityManager = require('./capability');
                    const allCapabilities = await CapabilityManager.getCapabilities();

                    let workflow = allCapabilities.find(w =>
                        w.id === params.workflow_id ||
                        w.name === params.workflow_id ||
                        w.id === params.id ||
                        w.name === params.id
                    );

                    if (!workflow) {
                        const WorkflowManager = require('./workflow');
                        workflow = await WorkflowManager.getRawWorkflow(params.workflow_id || params.id);
                    }

                    if (!workflow) {
                        throw jsonrpc.INTERNAL_ERROR(`Workflow ${params.workflow_id || params.id} not found`);
                    }

                    return await provider.generateCases({
                        workflow,
                        count: params.count || 5,
                        model
                    });
                }, 'agent.case.generate');
            }
        },
        /**
         * agent.decide — structured, schema-bound decision (the AI ↔ manual boundary).
         * @why Fail-soft by design: provider/parse failure or low confidence returns
         *      escalate:true rather than throwing, so it is NOT wrapped in
         *      withRetryableError. See logic/decide.js for the inverted-gate + degradability rules.
         */
        decide: (params) => decideLogic.decide(params)
    }
};

module.exports = methods;
