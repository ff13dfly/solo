const config = require('../config');
const chalk = require('chalk');
const redis = require('redis');
const WorkflowManager = require('./workflow');
const { createLogger } = require('../../../library/logger');

const logger = createLogger(config.serviceName);

/**
 * Capability Manager
 * @why Acts as the "Discovery Hub" for the Agent. It bridges the gap between 
 *      the Router's global registry and the Agent's local reasoning.
 * @attention 
 *   1. LOCAL CACHE: Uses a 10s TTL local cache (`CACHE_TTL`) to avoid 
 *      Redis network overhead on every user input.
 *   2. ENRICHMENT: Merges simple RPC methods with complex multi-step workflows.
 *   3. LATE BINDING: Descriptions are dynamically localized (zh/en) at retrieval time.
 */
class CapabilityManager {
    // --- INITIALIZATION ---
    constructor() {
        this.capabilities = [];
        this.workflows = [];
        this.lastUpdate = 0;
        this.CACHE_TTL = 10 * 1000; 
        
        this.redisClient = redis.createClient({
            url: config.redisUrl
        });
        
        this.redisClient.on('error', err => logger.error('Redis Error', err));
        this.redisClient.connect().then(() => {
            logger.setRedis(this.redisClient); // Bind for error reporting
        }).catch(err => logger.error('Redis Connect Error', err));
    }

    // --- CAPABILITY DISCOVERY ---

    /**
     * Retrieve all available capabilities (Methods + Workflows)
     * 
     * @why Central entry point for getting the system's "Ability Map".
     * @attention 
     *   1. PARALLEL FETCH: Fetches standard capabilities and complex workflows 
     *      simultaneously to reduce latency.
     *   2. TRANSFORMATION: Converts the Redis Map structure into a Flat Array for 
     *      easier processing by LLM Phase 1.
     * @side_effects Updates `this.capabilities`, `this.workflows`, and `this.lastUpdate`.
     */
    async getCapabilities(forceRefresh = false) {
        // 1. Check Memory Cache
        if (!forceRefresh && this.capabilities.length > 0 && (Date.now() - this.lastUpdate < this.CACHE_TTL)) {
            return [...this.capabilities, ...this.workflows];
        }

        logger.debug('Fetching capabilities from Redis...');
        try {
            if (!this.redisClient.isOpen) await this.redisClient.connect();

            // 2. Fetch from Shared Redis Key (Populated by Router)
            const [dataStr, servicesStr, workflows] = await Promise.all([
                this.redisClient.get(config.redis.capabilityKey),
                this.redisClient.get(config.redis.activeServicesKey),
                WorkflowManager.getWorkflows(forceRefresh)
            ]);
            
            this.workflows = workflows || [];
            this.serviceDescriptions = {};

            if (servicesStr) {
                const services = JSON.parse(servicesStr);
                // Parse service-level descriptions for higher-level AI classification
                Object.entries(services).forEach(([name, svc]) => {
                    if (svc.description) {
                        this.serviceDescriptions[name] = svc.description;
                    }
                });
            }

            if (dataStr) {
                const map = JSON.parse(dataStr);
                // Transform map object to flat array for prompt feeding
                this.capabilities = Object.entries(map).map(([key, val]) => ({
                    name: key,
                    desc: val.desc || val.description || '',
                    params: val.params,
                    service: val.service
                }));
                this.lastUpdate = Date.now();
                logger.info(`Loaded ${this.capabilities.length} capabilities & ${this.workflows.length} workflows from Redis.`);
            } else {
                 logger.warn('No capabilities found in Redis (Key might be empty).');
            }
        } catch (error) {
            logger.error('Failed to fetch capabilities from Redis:', error.message);
            // Return existing cache if update fails to ensure service continuity
            if (this.capabilities.length === 0) return [];
        }

        return [...this.capabilities, ...this.workflows];
    }

    // --- PROMPT FORMATTING ---

    /**
     * getServiceDescriptions
     * @why Provides high-level "Service Identity" to the AI for category classification.
     */
    getServiceDescriptions(lang = 'en') {
        // Return a string formatted for Prompt: "- serviceName: description"
        const lines = [];
        for (const [name, descObj] of Object.entries(this.serviceDescriptions || {})) {
            const localDesc = descObj[lang] || descObj['en'];
            if (localDesc && localDesc.main) {
                lines.push(`- ${name}: ${localDesc.main.join('; ')}`);
            }
        }
        return lines.join('\n');
    }

    /**
     * Get detailed methods for a specific service
     * 
     * @why Used in Phase 2 or Focus mode to provide deeper context once 
     *      a candidate service is selected.
     * @attention Prefers structured introspected descriptions over simple name-only entries.
     */
    getMethodsForService(serviceName, lang = 'en') {
        const methods = this.capabilities.filter(c => c.service === serviceName);
        
        let enrichedMethods = methods.map(m => `- ${m.name}: ${m.desc}`).join('\n');
        
        const svcDesc = this.serviceDescriptions && this.serviceDescriptions[serviceName];
        if (svcDesc) {
            const localDesc = svcDesc[lang] || svcDesc['en'];
            if (localDesc && localDesc.methods) {
                // Return structured list from rich config if available
                enrichedMethods = Object.entries(localDesc.methods)
                    .map(([k, v]) => `- ${k}: ${v.join('; ')}`)
                    .join('\n');
            }
        }
        return enrichedMethods;
    }
}

module.exports = new CapabilityManager();
