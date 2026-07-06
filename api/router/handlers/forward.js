const axios = require('axios');
const tweetnacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

// --- RPC FORWARDING LOGIC ---

/**
 * Sign and forward a JSON-RPC request to a target microservice.
 * 
 * @param {object} options - Forwarding configuration including session and keypair.
 * @returns {Promise<object>} The raw result from the upstream service.
 * 
 * @why Implements "Level 3 Security": Every request forwarded by the router is cryptographically 
 *      signed using Ed25519. Downstream services verify this signature against the router's 
 *      public key to trust the associated user session.
 * @attention 
 *   1. TOKEN STRUCTURE: Includes 'iss', 'iat', 'user', and 'permit' for stateless auth upstream.
 *   2. HEADER PASSTHROUGH: Preserves original Authorization headers if present to maintain 
 *      multi-tier session validity.
 */
async function forwardRequest({
    targetService,
    method,
    params,
    jsonrpc,
    id,
    sessionUser,
    isAdmin,
    keypair,
    debug,
    sourceHeaders = {},
    traceCtx = null
}) {
    // Generate Level 3 Auth Payload
    const authPayload = {
        iss: 'router',
        iat: Date.now(),
        user: sessionUser.uid || sessionUser.username || 'anonymous',
        permit: isAdmin ? 'admin' : 'user',
        constraints: sessionUser.permit?.constraints || {},
        meta: {
            ...(sessionUser.meta || {}),
            // Chain correlation (handlers/trace.js): services read req.meta.trace /
            // req.meta.depth and thread them through walContext → WAL rows, relay calls.
            ...(traceCtx ? { trace: traceCtx.trace, depth: traceCtx.depth } : {})
        }
    };

    // Sign payload
    const payloadStr = JSON.stringify(authPayload);
    const payloadBytes = new TextEncoder().encode(payloadStr);
    const signature = tweetnacl.sign.detached(payloadBytes, keypair.secretKey);

    const headers = {
        'Content-Type': 'application/json',
        'X-Router-Token': bs58.encode(Buffer.from(payloadStr)),
        'X-Router-Signature': bs58.encode(signature)
    };

    // Propagate original credentials for deep service authorization
    if (sourceHeaders['authorization']) headers['authorization'] = sourceHeaders['authorization'];
    if (sourceHeaders['x-admin-token']) headers['x-admin-token'] = sourceHeaders['x-admin-token'];

    const enrichedBody = {
        jsonrpc,
        method,
        params,
        id
    };

    if (debug) {
        console.log(`[Forward] ${method} -> ${targetService.url}`);
    }

    // Execute upstream call
    // AI Agent calls take significantly longer (20-60s) for multimodal processing
    const timeout = method.startsWith('agent') ? 90000 : method.startsWith('gateway') ? 60000 : 10000;
    const serviceRes = await axios.post(targetService.url, enrichedBody, {
        headers,
        timeout: timeout
    });

    return serviceRes.data;
}

// --- TASK & RESPONSE PROCESSING ---

/**
 * Extract background tasks defined in the special "_tasks" response field.
 * 
 * @why Allows downstream services to trigger asynchronous operations (like log inserts 
 *      or notifications) that the router handles in the background after returning 
 *      the main result to the client.
 */
function extractTasks(responseData) {
    if (responseData && responseData.result && responseData.result._tasks) {
        const tasks = responseData.result._tasks;
        delete responseData.result._tasks; // Sanitize result before sending to client
        return tasks;
    }
    return null;
}

// --- ERROR HANDLING ---

const jsonrpcHandler = require('./jsonrpc');

/**
 * Standardize upstream service failures for JSON-RPC 2.0 compliance.
 */
function createUpstreamError(errMessage, id) {
    const errorBody = jsonrpcHandler.UPSTREAM_ERROR('unknown', errMessage);
    return {
        jsonrpc: '2.0',
        error: errorBody,
        id
    };
}

module.exports = {
    forwardRequest,
    extractTasks,
    createUpstreamError
};
