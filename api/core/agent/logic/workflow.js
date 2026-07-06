const redis = require('redis');
const config = require('../config');
const { createLogger } = require('../../../library/logger');

const logger = createLogger(config.serviceName);

// --- WORKFLOW SNAPSHOT MANAGER ---

/**
 * WorkflowManager
 * @why Resolves machine-executable workflows that the Agent uses for 
 *      second-phase intent matching and focus mode.
 * @attention 
 *   1. SNAPSHOTS: Primarily consumes "pre-built" snapshots from Redis for performance.
 *   2. RAW FALLBACK: Can fetch directly from Orchestrator storage for debug/draft modes.
 */
class WorkflowManager {
    // --- INITIALIZATION ---
    constructor() {
        this.workflows = [];
        this.lastUpdate = 0;
        this.CACHE_TTL = 10 * 1000;
        this.SNAPSHOT_KEY = config.redis.workflowSnapshotKey;
        
        this.redisClient = redis.createClient({
            url: config.redisUrl || 'redis://localhost:6379'
        });
        
        this.redisClient.on('error', err => logger.error('Redis Error', err));
        this.redisClient.connect().catch(err => logger.error('Redis Connect Error', err));
    }

    // --- SNAPSHOT RESOLUTION ---

    async getWorkflows(forceRefresh = false) {
        if (!forceRefresh && this.workflows.length > 0 && (Date.now() - this.lastUpdate < this.CACHE_TTL)) {
            return this.workflows;
        }

        logger.debug('Fetching workflow snapshots from Redis...');
        try {
            if (!this.redisClient.isOpen) await this.redisClient.connect();

            const dataStr = await this.redisClient.get(this.SNAPSHOT_KEY);
            if (dataStr) {
                this.workflows = JSON.parse(dataStr);
                this.lastUpdate = Date.now();
                logger.info(`Loaded ${this.workflows.length} workflows from snapshot.`);
            } else {
                logger.debug('No workflow snapshot found.');
                this.workflows = [];
            }
        } catch (error) {
            logger.error('Failed to fetch workflow snapshot:', error.message);
            if (this.workflows.length === 0) return [];
        }

        return this.workflows;
    }

    // --- RAW STORAGE ACCESS (Bypass) ---

    /**
     * Fetch a workflow directly from Orchestrator storage (bypass build snapshot)
     */
    async getRawWorkflow(id) {
        if (!id) return null;
        try {
            if (!this.redisClient.isOpen) await this.redisClient.connect();
            // Orchestrator Key: ORCHESTRATOR:WORKFLOW:{id}
            const raw = await this.redisClient.json.get(`${config.redis.rawWorkflowPrefix}${id}`);
            if (raw) {
                logger.debug(`Resolved raw workflow ${id} directly from Redis (Draft/Debug mode).`);
                return {
                    id: raw.id,
                    type: 'workflow',
                    name: raw.name,
                    desc: raw.desc,
                    required_inputs: raw.required_inputs || [],
                    optional_inputs: raw.optional_inputs || [],
                    steps: raw.steps || []
                };
            }
        } catch (e) {
            logger.error('Failed to fetch raw workflow:', e.message);
        }
        return null;
    }
}

module.exports = new WorkflowManager();
