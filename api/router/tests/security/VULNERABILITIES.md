# Solo.AI Router Security Vulnerability Registry

This document tracks identified security vulnerabilities in the Solo Router, their impact, and the corresponding mitigation strategies implemented.

## 1. Prototype Pollution (Hung Request)
- **ID**: `SOLO-SEC-001`
- **Impact**: **High (DoS)**. Exploiting `__proto__` in the JSON-RPC method dispatcher could cause the Node.js process to throw an unhandled rejection, hanging the HTTP connection and potentially exhausting the server's connection pool.
- **Fix**: Replaced direct object property access `METHODS[method]` with `Object.prototype.hasOwnProperty.call(METHODS, method)`.
- **Status**: **FIXED**

## 2. Parameter Size Exhaustion (OOM)
- **ID**: `SOLO-SEC-002`
- **Impact**: **High (DoS)**. Maliciously large strings, arrays, or objects in JSON-RPC parameters could cause the Router or downstream services to run out of memory.
- **Fix**: Implemented `MAX_STRING_LENGTH` and `MAX_ARRAY_LENGTH` checks in `validator.js`.
- **Status**: **FIXED**

## 3. JSON.parse Crash (DoS)
- **ID**: `SOLO-SEC-003`
- **Impact**: **High (DoS)**. Malformed JSON strings in Redis (e.g., session data) would cause a synchronous exception during `JSON.parse`, crashing the entire Node.js process.
- **Fix**: Wrapped session parsing in `auth.js` with `try...catch` and fallback to anonymous guest session.
- **Status**: **FIXED**

## 4. Unauthenticated Static Assets Access (IDOR)
- **ID**: `SOLO-SEC-004`
- **Impact**: **Medium-High (Data Leak)**. The `/assets` route served files directly from disk without any authentication, allowing anyone to download uploaded files if they could guess the filename.
- **Fix**: Added a `requireAuth` middleware to the `/assets` route that validates tokens from headers or query parameters.
- **Status**: **FIXED**

## 5. System Topology Exposure (Information Disclosure)
- **ID**: `SOLO-SEC-005`
- **Impact**: **Low-Medium**. Detailed error messages or internal metadata could expose the system topology to attackers.
- **Fix**: Standardized JSON-RPC error responses and suppressed internal stack traces in production.
- **Status**: **FIXED**
