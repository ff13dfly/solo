const axios = require('axios');
const chalk = require('chalk');
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const config = require('../config');
const { enrichCapabilityMap } = require('./capability');

// --- SERVICE DISCOVERY (Z-HANDSHAKE) ---

/**
 * Perform a "Z-Handshake" to register a new microservice.
 * 
 * @param {string} inputUrl - The raw base URL of the downstream service.
 * @param {object} SERVICES - Global services registry.
 * @param {object} redisClient - Active Redis client for persistence.
 * @param {object} keypair - Router's identity keypair for signing the seed.
 * @param {object} CAPABILITY_MAP - Map to be populated with discovered methods.
 * 
 * @process
 *   1. GET /auth/seed: Fetch a unique challenge from the service.
 *   2. SIGN: Use the Router's secret key to sign the challenge.
 *   3. VERIFY: Send the signature back to the service to establish trust.
 *   4. INTROSPECT: Fetch 'methods' and optional 'entities' to build the capability map.
 * 
 * @why Establishes a cryptographically secure "Chain of Trust" between the Router 
 *      and its microservices without pre-shared keys.
 */
async function addService(inputUrl, SERVICES, redisClient, keypair, CAPABILITY_MAP) {
    let baseUrl = inputUrl.replace(/\/$/, '').replace(/\/jsonrpc$/, '');
    console.log(chalk.cyan(`[Discovery] Initiating handshake with: ${baseUrl}`));

    // 1. Fetch Challenge Seed
    const seedRes = await axios.get(`${baseUrl}/auth/seed`, { timeout: 3000 });
    const { seed } = seedRes.data;
    if (!seed) throw new Error('Target service failed to provide a challenge seed');

    // 2. Compute Signature
    const message = new TextEncoder().encode(seed);
    const signature = bs58.encode(tweetnacl.sign.detached(message, keypair.secretKey));

    // 3. Complete Handshake
    const verifyRes = await axios.post(`${baseUrl}/auth/verify`, {
        signature,
        publicKey: keypair.publicKey.toBase58()
    }, { timeout: 3000 });

    if (verifyRes.data.success) {
        // 4. Introspection Phase
        const methodRes = await axios.post(`${baseUrl}/jsonrpc`, {
            jsonrpc: '2.0',
            method: 'methods',
            id: 'handshake'
        }, { timeout: 5000 });

        let methods = [];
        let description = {};

        if (Array.isArray(methodRes.data.result)) {
            methods = methodRes.data.result;
        } else if (methodRes.data.result && methodRes.data.result.methods) {
            methods = methodRes.data.result.methods;
            description = methodRes.data.result.description || {};
        }

        // 5. Schema/Entity Discovery (Best Effort)
        let entities = {};
        try {
            const entitiesRes = await axios.post(`${baseUrl}/jsonrpc`, {
                jsonrpc: '2.0',
                method: 'entities',
                id: 'handshake'
            }, { timeout: 3000 });

            if (entitiesRes.data && entitiesRes.data.result) {
                entities = entitiesRes.data.result;
            }
        } catch (e) {
            // Non-fatal: Not all services support entity schema extraction
        }

        const serviceName = verifyRes.data.serviceName || `service_${Date.now()}`;
        const serviceVersion = verifyRes.data.version || 'v0.0.0';

        // Finalize Registry Entry
        SERVICES[serviceName] = {
            url: `${baseUrl}/jsonrpc`,
            methods: methods,
            entities: entities,
            description: description,
            available: true,
            version: serviceVersion,
            lastLink: Date.now()
        };

        // Populate Capability Map for immediate use
        if (CAPABILITY_MAP && methods.length > 0) {
            methods.forEach(m => {
                CAPABILITY_MAP[m.name] = {
                    service: serviceName,
                    url: `${baseUrl}/jsonrpc`,
                    desc: m.description,
                    params: m.params,
                    returns: m.returns,
                    ai: m.ai || false,
                    public: m.public || false,
                    limit: m.limit || null,
                    serviceDesc: description
                };
            });
            enrichCapabilityMap();
        }

        // Persist to Redis
        if (redisClient && redisClient.isOpen) {
            await redisClient.set(config.redis.activeServicesKey, JSON.stringify(SERVICES));
            if (CAPABILITY_MAP) {
                await redisClient.set(config.redis.capabilityKey, JSON.stringify(CAPABILITY_MAP));
            }
        }

        console.log(chalk.green(`[Discovery] Service "${serviceName}" registered successfully (${methods.length} methods)`));
        return { serviceName, methods, version: serviceVersion };
    } else {
        throw new Error('Handshake verification rejected by target service');
    }
}

// --- RPC HANDLERS ---

/**
 * Factory for service-related administration RPC methods.
 */
function createServiceHandlers(SERVICES, CAPABILITY_MAP, redisClient) {
    return {
        /**
         * system.service.status
         * Verify connectivity to a downstream service and update its metadata.
         */
        async checkServiceStatus(params, id, res) {
            const { serviceId } = params;
            const svc = SERVICES[serviceId];
            if (!svc) return res.json({ jsonrpc: '2.0', error: { code: -32004, message: 'Service not found in registry' }, id });

            try {
                const start = Date.now();

                // Perform a lightweight 'ping' to check liveness
                const pingRes = await axios.post(svc.url, {
                    jsonrpc: '2.0',
                    method: 'ping',
                    id: 'status-check'
                }, { timeout: 3000 });

                const latency = Date.now() - start;
                svc.lastLink = Date.now();
                svc.available = true;

                // Update basic metrics
                if (pingRes.data && pingRes.data.result) {
                    if (pingRes.data.result.version) svc.version = pingRes.data.result.version;
                }

                // Periodic Metadata Refresh (Entities & Methods)
                try {
                    // 1. Refresh Entities
                    const entitiesRes = await axios.post(svc.url, {
                        jsonrpc: '2.0',
                        method: 'entities',
                        id: 'status-check'
                    }, { timeout: 2000 });
                    if (entitiesRes.data && entitiesRes.data.result) {
                        svc.entities = entitiesRes.data.result;
                    }

                    // 2. Refresh Methods & Capability Map
                    const methodsRes = await axios.post(svc.url, {
                        jsonrpc: '2.0',
                        method: 'methods',
                        id: 'status-check'
                    }, { timeout: 2000 });

                    if (methodsRes.data && methodsRes.data.result) {
                        const newMethods = Array.isArray(methodsRes.data.result)
                            ? methodsRes.data.result
                            : (methodsRes.data.result.methods || []);

                        svc.methods = newMethods;

                        // Patch CAPABILITY_MAP for this service
                        if (CAPABILITY_MAP) {
                            newMethods.forEach(m => {
                                CAPABILITY_MAP[m.name] = {
                                    service: serviceId,
                                    url: svc.url,
                                    desc: m.description,
                                    params: m.params,
                                    returns: m.returns,
                                    ai: m.ai || false,
                                    public: m.public || false,
                                    limit: m.limit || null
                                };
                            });
                        }
                    }

                    // 3. Refresh Events declaration (best effort)
                    try {
                        const eventsRes = await axios.post(svc.url, {
                            jsonrpc: '2.0',
                            method: 'events',
                            id: 'status-check'
                        }, { timeout: 2000 });
                        if (eventsRes.data && eventsRes.data.result) {
                            svc.events = eventsRes.data.result;
                        }
                    } catch (_) { /* service may not have events handler yet */ }

                } catch (e) {
                    console.warn(`[Discovery] Metadata refresh failed for ${serviceId}:`, e.message);
                }

                if (redisClient && redisClient.isOpen) {
                    await redisClient.set(config.redis.activeServicesKey, JSON.stringify(SERVICES));
                    if (CAPABILITY_MAP) {
                        await redisClient.set(config.redis.capabilityKey, JSON.stringify(CAPABILITY_MAP));
                    }
                }

                return res.json({
                    jsonrpc: '2.0',
                    result: {
                        status: 'online',
                        latency,
                        lastLink: svc.lastLink,
                        entities: svc.entities,
                        methods: svc.methods,
                        events: svc.events || null
                    },
                    id
                });
            } catch (e) {
                svc.available = false;
                if (redisClient && redisClient.isOpen) {
                    await redisClient.set(config.redis.activeServicesKey, JSON.stringify(SERVICES));
                }
                return res.json({ jsonrpc: '2.0', result: { status: 'offline', error: e.message }, id });
            }
        },

        /**
         * system.capability.list
         * Retrieve the filtered map of available capabilities for AI or public discovery.
         */
        capabilities(params, id, res, isAdmin = false) {
            const systemApi = require('../logic/system');
            const result = { ...CAPABILITY_MAP };

            // Inject internal router registry metadata as virtual services
            Object.entries(systemApi).forEach(([method, meta]) => {
                result[method] = {
                    ...result[method],
                    ...meta,
                    service: result[method]?.service || 'router'
                };
            });

            // Admin bypass: access raw underlying map
            if (params?.all === true && isAdmin) {
                return res.json({ jsonrpc: '2.0', result, id });
            }

            // Filter for AI-ready or Publicly available methods
            const discoveryMap = {};
            Object.entries(result).forEach(([key, val]) => {
                if (val.ai === true || val.public === true) {
                    discoveryMap[key] = val;
                }
            });

            return res.json({ jsonrpc: '2.0', result: discoveryMap, id });
        },

        /**
         * system.service.list
         * Return a full manifest of all registered microservices.
         */
        listServices(id, res) {
            const list = Object.entries(SERVICES).map(([id, svc]) => ({
                id,
                url: svc.url,
                available: svc.available,
                status: svc.available ? 'online' : 'offline',
                lastSeen: svc.lastLink ? new Date(svc.lastLink).toISOString() : null,
                version: svc.version,
                description: svc.description,
                methods: svc.methods || [],
                entities: svc.entities || {}
            }));
            return res.json({ jsonrpc: '2.0', result: list, id });
        },

        /**
         * system.remove_service
         * Deregister a service and clean up all associated capabilities immediately.
         */
        async removeService(params, id, res) {
            const serviceId = params.serviceId || params.name;
            if (SERVICES[serviceId]) {
                delete SERVICES[serviceId];

                // Cascade Deletion: Remove methods from capability map
                Object.keys(CAPABILITY_MAP).forEach(key => {
                    if (CAPABILITY_MAP[key].service === serviceId) {
                        delete CAPABILITY_MAP[key];
                    }
                });

                if (redisClient && redisClient.isOpen) {
                    await redisClient.set(config.redis.activeServicesKey, JSON.stringify(SERVICES));
                    await redisClient.set(config.redis.capabilityKey, JSON.stringify(CAPABILITY_MAP));
                }

                console.log(chalk.yellow(`[Discovery] Service "${serviceId}" removed by administrator`));
                return res.json({ jsonrpc: '2.0', result: { success: true }, id });
            } else {
                return res.json({ jsonrpc: '2.0', error: { code: -32004, message: 'Service not found in registry' }, id });
            }
        }
    };
}

// --- BOOTSTRAP HELPERS ---

/**
 * Ensure the default Administrator service is present in the registry.
 */
function ensureAdministratorService(SERVICES, adminUrl) {
    if (!SERVICES.administrator) {
        SERVICES.administrator = {
            url: `${adminUrl}/jsonrpc`,
            methods: [],
            available: true,
            version: 'internal',
            lastLink: Date.now()
        };
        console.log('[Bootstrap] Administrator service linked (default)');
    }
}

module.exports = { createServiceHandlers, addService, ensureAdministratorService };
