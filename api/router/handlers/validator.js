const systemApi = require('../logic/system');
const config = require('../config');
const jsonrpcHandler = require('./jsonrpc');
const { hasControlChars, isBlank, PATTERNS } = require('../../library/validate');
const { createLogger } = require('../../library/logger');

const vLog = createLogger('ParamValidation');

const MAX_STRING_LENGTH = config.maxStringLength || 5242880;
const MAX_ARRAY_LENGTH = config.maxArrayLength || 1000;
// Known binary payload params that carry base64 image/audio data
const BINARY_PARAM_NAMES = new Set(['image', 'audio', 'file', 'data', 'base64']);
const MAX_BINARY_LENGTH = 10485760; // 10MB base64 specifically for binary fields

/**
 * Gate for the NEW param-hygiene rules (control-char floor, blank-required, pattern, minLength).
 * Read the mode dynamically (env first, then config) so tests/simulations can flip it without
 * module-cache juggling.
 *   - 'enforce' → return the error object so the caller rejects with -32602
 *   - 'warn' (default) → log it and return null so the request passes (observe-first rollout)
 * Existing size/type/required-missing checks do NOT go through here — they always enforce.
 */
function blockNew(errObj) {
    const enforce = (process.env.PARAM_VALIDATION || config.paramValidation || 'warn') === 'enforce';
    if (enforce) return errObj;
    vLog.warn(`[warn-mode] ${errObj.message}`);
    return null;
}

// --- PARAMETER VALIDATION ---

/**
 * Perform baseline size validation and schema enforcement on RPC parameters.
 * 
 * @param {object} params - Key-value pair of request parameters.
 * @param {Array} [methodSchema] - Optional array of parameter requirements.
 * @returns {object|null} A JSON-RPC error object if validation fails, otherwise null.
 * 
 * @why Acts as the "Contract Enforcer" and "OOM Shield". By validating sizes 
 *      and schemas at the Router level, we prevent malformed or excessively 
 *      large requests from reaching downstream microservices.
 */

/**
 * Phase 0: Global baseline size validation to prevent OOM.
 */
function validateGlobalConstraints(params, schema) {
    if (!params || typeof params !== 'object') return null;

    // Build a quick lookup for per-param maxLength overrides from schema
    const schemaLimits = {};
    if (Array.isArray(schema)) {
        for (const item of schema) {
            if (item.name && item.maxLength) schemaLimits[item.name] = item.maxLength;
        }
    }

    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;

        // Generic floor (mode-gated): no control chars in string params. Binary/base64 fields
        // are exempt (they legitimately carry arbitrary bytes). \t \n \r remain legal.
        if (typeof value === 'string' && !BINARY_PARAM_NAMES.has(key) && hasControlChars(value)) {
            const blocked = blockNew(jsonrpcHandler.INVALID_PARAMS(`parameter '${key}' contains control characters`));
            if (blocked) return blocked;
        }

        const limit = schemaLimits[key] || (BINARY_PARAM_NAMES.has(key) ? MAX_BINARY_LENGTH : MAX_STRING_LENGTH);
        if (typeof value === 'string' && value.length > limit) {
            return jsonrpcHandler.INVALID_PARAMS(`parameter '${key}' length exceeds maximum limit of ${limit} chars`);
        }

        if (Array.isArray(value) && value.length > MAX_ARRAY_LENGTH) {
            return jsonrpcHandler.INVALID_PARAMS(`array parameter '${key}' exceeds maximum limit of ${MAX_ARRAY_LENGTH} items`);
        }

        if (typeof value === 'object' && !Array.isArray(value)) {
            try {
                const objString = JSON.stringify(value);
                if (objString.length > MAX_STRING_LENGTH * 2) {
                    return jsonrpcHandler.INVALID_PARAMS(`object parameter '${key}' is excessively large`);
                }
            } catch (e) {
                return jsonrpcHandler.INVALID_PARAMS(`object parameter '${key}' is malformed`);
            }
        }
    }
    return null;
}

/**
 * Phase 1: Explicit schema validation against introspected method definitions.
 */
function validateParams(params, methodSchema) {
    // 1. Run global baseline check first (pass schema so maxLength overrides are respected)
    const globalError = validateGlobalConstraints(params, methodSchema);
    if (globalError) return globalError;

    // 2. Skip if no specific schema is provided
    if (!methodSchema || !Array.isArray(methodSchema) || methodSchema.length === 0) {
        return null;
    }

    for (const item of methodSchema) {
        if (typeof item !== 'object' || !item.name) {
            continue;
        }

        const value = params[item.name];

        // 1. Mandatory Parameter Check
        if (item.required && (value === undefined || value === null)) {
            return jsonrpcHandler.INVALID_PARAMS(`missing mandatory field '${item.name}'`);
        }

        // 1.5 String-hygiene rules (mode-gated): blank-required, minLength, named pattern.
        //     Only fire for string values; opt-in per field via the introspection schema.
        if (typeof value === 'string') {
            if (item.required && isBlank(value)) {
                const blocked = blockNew(jsonrpcHandler.INVALID_PARAMS(`'${item.name}' must not be blank`));
                if (blocked) return blocked;
            }
            if (item.minLength && value.length < item.minLength) {
                const blocked = blockNew(jsonrpcHandler.INVALID_PARAMS(`'${item.name}' is shorter than minimum length of ${item.minLength}`));
                if (blocked) return blocked;
            }
            if (item.pattern && PATTERNS[item.pattern] && !PATTERNS[item.pattern].test(value)) {
                const blocked = blockNew(jsonrpcHandler.INVALID_PARAMS(`'${item.name}' has invalid format (expected ${item.pattern})`));
                if (blocked) return blocked;
            }
        }

        // 2. Data Type Enforcement
        if (value !== undefined && value !== null && item.type) {
            const actualType = Array.isArray(value) ? 'array' : typeof value;
            if (actualType !== item.type) {
                return jsonrpcHandler.INVALID_PARAMS(`type mismatch for '${item.name}' (expected ${item.type}, got ${actualType})`);
            }

            // 3. Precise Size Constraints (schema-level maxLength overrides global limit)
            const strLimit = (item.type === 'string' && item.maxLength) ? item.maxLength : MAX_STRING_LENGTH;
            if (item.type === 'string' && value.length > strLimit) {
                return jsonrpcHandler.INVALID_PARAMS(`'${item.name}' length exceeds maximum limit of ${strLimit} chars`);
            }
            if (item.type === 'array' && value.length > MAX_ARRAY_LENGTH) {
                return jsonrpcHandler.INVALID_PARAMS(`array '${item.name}' exceeds maximum limit of ${MAX_ARRAY_LENGTH} items`);
            }
            if (item.type === 'object') {
                try {
                    const objString = JSON.stringify(value);
                    if (objString.length > MAX_STRING_LENGTH * 2) {
                        return jsonrpcHandler.INVALID_PARAMS(`object '${item.name}' is too deeply nested or excessively large`);
                    }
                } catch (e) {
                    return jsonrpcHandler.INVALID_PARAMS(`object '${item.name}' cannot be safely checked`);
                }
            }
        }
    }

    return null;
}

// --- PUBLIC DISCOVERY ---

/**
 * Check if the requested method belongs to the hardcoded public registry.
 */
function isPublicMethod(method) {
    return !!(systemApi[method] && systemApi[method].public);
}

module.exports = {
    validateParams,
    validateGlobalConstraints,
    isPublicMethod
};
