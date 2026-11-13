/**
 * Cross-Box SOLO Peer Agent Provider (`api/core/agent/providers/solo-peer.js`)
 *
 * Allows a headless Linux SOLO node without a local GPU (e.g. `BC001` / `BC002`)
 * to delegate `agent.*` inference calls to another SOLO stack that hosts local
 * multimodal compute (e.g. `catalog-mini` Mac mini M4 running Ollama `qwen3.5:9b`)
 * via the standard SOLO Router `/jsonrpc` protocol (`library/peer-relay.js`).
 *
 * Model routing syntax:
 *   - `solo-peer/ollama/qwen3.5:9b` -> calls remote `agent.*` with `model: "ollama/qwen3.5:9b"`
 *   - `solo-peer/qwen-max`          -> calls remote `agent.*` with `model: "qwen-max"`
 *   - `solo-peer`                   -> calls remote `agent.*` with default model (`ollama/qwen3.5:9b`)
 *
 * Business services on the caller node still only call local `relay.call('agent.*')`;
 * cross-box transport, auth handshake, token refresh, and hop guard are encapsulated here.
 */

const { createPeerRelay } = require('../../../library/peer-relay');
const { createLogger } = require('../../../library/logger');

const logger = createLogger('agent');

function stripSoloPeerPrefix(model, fallback = 'ollama/qwen3.5:9b') {
    const raw = String(model || '').trim();
    if (!raw || raw.toLowerCase() === 'solo-peer') return fallback;
    const stripped = raw.replace(/^solo-peer[/:]/i, '').trim();
    if (/^solo-peer(?:$|[/:])/i.test(stripped)) {
        throw new Error(`SoloPeerProvider: recursive solo-peer model routing is not allowed ("${raw}")`);
    }
    return stripped || fallback;
}

class SoloPeerProvider {
    constructor(config = {}) {
        this.config = config;
        this.defaultDownstreamModel = config.peerAgentDefaultModel || 'ollama/qwen3.5:9b';
        this.peerRelay = config.peerRelay || createPeerRelay({
            endpoint: config.peerAgentUrl || process.env.SOLO_AGENT_PEER_URL || '',
            apiKey: config.peerAgentApiKey || process.env.SOLO_AGENT_PEER_API_KEY || '',
            token: config.peerAgentToken || process.env.SOLO_AGENT_PEER_TOKEN || '',
            user: config.peerAgentUser || process.env.SOLO_AGENT_PEER_USER || '',
            password: config.peerAgentPassword || process.env.SOLO_AGENT_PEER_PASSWORD || '',
            timeoutMs: Number(config.peerAgentTimeoutMs || process.env.SOLO_AGENT_PEER_TIMEOUT_MS || 60000),
            fetchFn: config.fetchFn,
        });
    }

    resolveDownstreamModel(model) {
        return stripSoloPeerPrefix(model, this.defaultDownstreamModel);
    }

    _decorateMetadata(res, downstreamModel) {
        if (!res || typeof res !== 'object') return res;
        return {
            ...res,
            metadata: {
                ...(res.metadata || {}),
                provider: 'solo-peer',
                upstreamProvider: res.metadata?.provider || 'remote',
                model: downstreamModel,
            },
        };
    }

    async chat(params = {}) {
        const downstreamModel = this.resolveDownstreamModel(params.model);
        const res = await this.peerRelay.call('agent.chat', {
            ...params,
            model: downstreamModel,
        });
        return this._decorateMetadata(res, downstreamModel);
    }

    async parseText(params = {}) {
        const downstreamModel = this.resolveDownstreamModel(params.model);
        const res = await this.peerRelay.call('agent.text.parse', {
            ...params,
            model: downstreamModel,
        });
        return this._decorateMetadata(res, downstreamModel);
    }

    async translateText(params = {}) {
        const downstreamModel = this.resolveDownstreamModel(params.model);
        const res = await this.peerRelay.call('agent.text.translate', {
            ...params,
            model: downstreamModel,
        });
        return this._decorateMetadata(res, downstreamModel);
    }

    async parseImage(params = {}) {
        const downstreamModel = this.resolveDownstreamModel(params.model);
        const res = await this.peerRelay.call('agent.image.parse', {
            ...params,
            model: downstreamModel,
        });
        return this._decorateMetadata(res, downstreamModel);
    }

    async extractProductInfo(params = {}) {
        const downstreamModel = this.resolveDownstreamModel(params.model);
        const res = await this.peerRelay.call('agent.image.parse', {
            ...params,
            mode: 'product',
            model: downstreamModel,
        });
        return this._decorateMetadata(res, downstreamModel);
    }

    async classifyImage(params = {}) {
        const downstreamModel = this.resolveDownstreamModel(params.model);
        const res = await this.peerRelay.call('agent.image.classify', {
            ...params,
            model: downstreamModel,
        });
        return this._decorateMetadata(res, downstreamModel);
    }

    async scanLabel(params = {}) {
        const downstreamModel = this.resolveDownstreamModel(params.model);
        return await this.peerRelay.call('agent.label.scan', {
            ...params,
            model: downstreamModel,
        });
    }

    /**
     * decide — delegates `agent.decide` to the remote SOLO peer and adapts the
     * response back into the provider contract expected by local `logic/decide.js`.
     */
    async decide({ instruction, context, choices, schema, model, threshold }) {
        const downstreamModel = this.resolveDownstreamModel(model);
        try {
            const res = await this.peerRelay.call('agent.decide', {
                instruction,
                context,
                choices,
                schema,
                threshold,
                model: downstreamModel,
            });
            if (!res || typeof res !== 'object') {
                return {
                    success: false,
                    error: 'Empty response from solo-peer agent.decide',
                    metadata: { provider: 'solo-peer', model: downstreamModel },
                };
            }
            if (res.escalate && res.decision === null) {
                return {
                    success: false,
                    error: res.reason || 'Remote peer escalated decision',
                    metadata: {
                        ...(res.metadata || {}),
                        provider: 'solo-peer',
                        model: downstreamModel,
                    },
                };
            }
            return {
                success: true,
                data: {
                    decision: res.decision,
                    confidence: res.confidence,
                    reason: res.reason,
                    ...(res.fields ? { fields: res.fields } : {}),
                },
                metadata: {
                    ...(res.metadata || {}),
                    provider: 'solo-peer',
                    upstreamProvider: res.metadata?.provider || 'remote',
                    model: downstreamModel,
                },
            };
        } catch (error) {
            logger.error('[SoloPeer] Decide Error:', error.message);
            return {
                success: false,
                error: error.message,
                metadata: { provider: 'solo-peer', model: downstreamModel },
            };
        }
    }

    async focus({ text, memory, workflow, currentParams, missingFields, model }) {
        const downstreamModel = this.resolveDownstreamModel(model);
        const res = await this.peerRelay.call('agent.focus', {
            workflow_id: workflow?.id || workflow?.name || 'workflow',
            workflow_name: workflow?.name,
            workflow_desc: workflow?.desc,
            synonyms: workflow?.synonyms,
            required_inputs: workflow?.required_inputs,
            user_input: text,
            memory,
            current_params: currentParams,
            missing_fields: missingFields,
            model: downstreamModel,
        });
        return this._decorateMetadata(res, downstreamModel);
    }
}

module.exports = SoloPeerProvider;
module.exports.stripSoloPeerPrefix = stripSoloPeerPrefix;
