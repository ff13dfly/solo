const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const CapabilityBuilder = require('../logic/capability');

// Path to hardcoded API returns data used for AI response extraction hints.
const API_RETURNS_FILE = path.join(__dirname, '../data/api-returns.json');

// --- DYNAMIC STATE ---

/**
 * Global Capability Mapping Table.
 * @attention This map is shared across the router for method-to-service resolution.
 */
const CAPABILITY_MAP = {};

/**
 * Cache for hardcoded API return structures.
 */
let API_RETURNS_CACHE = null;

// --- ENRICHMENT LOGIC ---

/**
 * Enrich the dynamic capability map with static return type metadata.
 * 
 * @why Enables the AI to know the expected JSON structure of an API result 
 *      without the downstream service explicitly defining it in every request.
 */
function enrichCapabilityMap() {
    if (!API_RETURNS_CACHE) return 0;

    let merged = 0;
    for (const [method, returns] of Object.entries(API_RETURNS_CACHE)) {
        if (CAPABILITY_MAP[method]) {
            CAPABILITY_MAP[method].returns = returns;
            merged++;
        }
    }
    return merged;
}

// --- CORE SYNCHRONIZATION ---

/**
 * Refresh the capability map by introspecting all active downstream services.
 * 
 * @param {object} SERVICES - Global services registry.
 * @param {object} redisClient - Active Redis client.
 * 
 * @why Discovers new methods and updates schemas automatically without router restarts.
 * @attention 
 *   1. ROBUSTNESS: If a service is offline, its existing capabilities are RETAINED 
 *      to prevent breaking the system due to transient network issues.
 *   2. ATOMIC SNAPSHOT: Periodically publishes an AI-optimized "Snapshot" to Redis 
 *      for the orchestrator to use in semantic planning.
 */
async function updateCapabilityMap(SERVICES, redisClient) {
    let hasChanges = false;

    for (const [name, svc] of Object.entries(SERVICES)) {
        if (!svc.url) continue;

        try {
            // Introspect Service via the standard 'methods' RPC call
            const res = await axios.post(svc.url, {
                jsonrpc: '2.0',
                method: 'methods',
                id: 'sys-map'
            }, { timeout: 5000 });

            let methods = [];
            let description = {};

            if (Array.isArray(res.data.result)) {
                methods = res.data.result;
            } else if (res.data.result && res.data.result.methods) {
                methods = res.data.result.methods;
                description = res.data.result.description || {};
            }

            if (methods.length > 0) {
                svc.methods = methods;
                svc.description = description;

                // 1. Cleanup stale methods that no longer exist in the service
                const currentServiceMethods = Object.keys(CAPABILITY_MAP).filter(k =>
                    CAPABILITY_MAP[k] && CAPABILITY_MAP[k].service === name
                );
                const newMethodNames = new Set(methods.map(m => m.name));

                currentServiceMethods.forEach(k => {
                    if (!newMethodNames.has(k)) {
                        delete CAPABILITY_MAP[k];
                        hasChanges = true;
                    }
                });

                // 2. Add or Update discovered methods
                methods.forEach(m => {
                    CAPABILITY_MAP[m.name] = {
                        service: name,
                        url: svc.url,
                        desc: m.description,
                        params: m.params,
                        returns: m.returns,
                        ai: m.ai || false,
                        public: m.public || false,
                        limit: m.limit || null,
                        serviceDesc: description
                    };
                });

                // 3. Refresh Entities (Best Effort)
                try {
                    const entitiesRes = await axios.post(svc.url, {
                        jsonrpc: '2.0',
                        method: 'entities',
                        id: 'sys-map'
                    }, { timeout: 3000 });
                    if (entitiesRes.data && entitiesRes.data.result) {
                        svc.entities = entitiesRes.data.result;
                    }
                } catch (ee) {
                    // Ignore non-fatal entity fetch failures
                }

                // 4. Refresh Events Declaration (Best Effort)
                try {
                    const eventsRes = await axios.post(svc.url, {
                        jsonrpc: '2.0',
                        method: 'events',
                        id: 'sys-map'
                    }, { timeout: 3000 });
                    if (eventsRes.data && eventsRes.data.result) {
                        svc.events = eventsRes.data.result;
                    }
                } catch (ee) {
                    // Ignore non-fatal events fetch failures
                }

                hasChanges = true;
            }
        } catch (e) {
            // Strategy: Passive Error Handling - retain old data during downtime.
            console.warn(`[Capability] Failed to introspect service "${name}": ${e.message}`);
        }
    }

    // Apply generic static overrides (hints for AI extraction)
    enrichCapabilityMap();

    // Persist changes to Redis for global visibility
    if (hasChanges && redisClient && redisClient.isOpen) {
        await redisClient.set(config.redis.capabilityKey, JSON.stringify(CAPABILITY_MAP));
        await redisClient.set(config.redis.activeServicesKey, JSON.stringify(SERVICES));

        // Publish AI Capability Snapshot (Semantic Index)
        const aiSnapshot = { zh: [], en: [] };
        for (const [name, svc] of Object.entries(SERVICES)) {
            if (svc.methods && svc.methods.length > 0) {
                const aiMethods = svc.methods.filter(m => m.ai === true);
                if (aiMethods.length > 0) {
                    const meta = CapabilityBuilder.buildCapabilityMeta(name, aiMethods, svc);
                    aiSnapshot.zh.push(...meta.zh);
                    aiSnapshot.en.push(...meta.en);
                }
            }
        }

        await redisClient.set(`${config.redis.capabilitySnapshotPrefix}:ZH`, JSON.stringify(aiSnapshot.zh));
        await redisClient.set(`${config.redis.capabilitySnapshotPrefix}:EN`, JSON.stringify(aiSnapshot.en));
        console.log(`[Capability] Published AI Semantic Snapshot (${aiSnapshot.zh.length} items)`);
    }
}

// --- DATA LOADING ---

/**
 * Load static return metadata from the local filesystem.
 */
function loadApiReturns() {
    try {
        if (fs.existsSync(API_RETURNS_FILE)) {
            API_RETURNS_CACHE = JSON.parse(fs.readFileSync(API_RETURNS_FILE, 'utf8'));
            const merged = enrichCapabilityMap();
            console.log(`[Capability] Static hints loaded: ${merged} methods enriched`);
            return merged;
        }
        return 0;
    } catch (e) {
        console.warn(`[Capability] Failed to load static hint data: ${e.message}`);
        return 0;
    }
}

// --- ACCESSORS ---

function getCapabilityMap() {
    return CAPABILITY_MAP;
}

function getRedisKey() {
    return config.redis.capabilityKey;
}

module.exports = {
    CAPABILITY_MAP,
    updateCapabilityMap,
    loadApiReturns,
    enrichCapabilityMap,
    getCapabilityMap,
    getRedisKey,
    REDIS_CAPABILITY_KEY: config.redis.capabilityKey
};

