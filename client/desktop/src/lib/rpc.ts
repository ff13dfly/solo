const AUTH_TOKEN_KEY = 'SOLO_AUTH_TOKEN';

/**
 * SHA-256 helper using Web Crypto API
 */
async function sha256(str: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Simple JSON-RPC 2.0 Client for Services
 */
export async function callRpc(method: string, params: any = {}) {
    const savedUrl = localStorage.getItem('SOLO_ROUTER_URL');
    const finalUrl = savedUrl || "http://localhost:8600";
    const token = localStorage.getItem(AUTH_TOKEN_KEY);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };

    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    try {
        const response = await fetch(finalUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
                jsonrpc: "2.0",
                method,
                params,
                id: Math.random().toString(36).substring(7),
            }),
        });

        const data = await response.json();

        if (data.error) {
            // Internal RPC error (method not found, logic error, etc.)
            // Preserve the full error details for downstream consumers.
            const msg = data.error.message || data.error.data?.message || "RPC Error";
            const hint = data.error.data?.hint;
            const err: any = new Error(hint ? `${msg} — ${hint}` : msg);
            err.code = data.error.code;
            err.data = data.error.data;
            throw err;
        }

        return data.result;
    } catch (err) {
        // Dispatch global event for connection failure
        window.dispatchEvent(new CustomEvent('solo:rpc_error', { detail: { method, error: err } }));
        throw err;
    }
}

/**
 * Complete challenge-response login flow
 */
export async function login(name: string, password: string) {
    // 1. Request Challenge
    const { challenge, salt } = await callRpc("user.login.request", { name });

    // 2. Compute Response
    const hash = await sha256(password + salt);
    const response = await sha256(challenge + hash);

    // 3. Verify Login
    const result = await callRpc("user.login.verify", {
        name,
        challenge,
        response,
        deviceId: 'desktop_web'
    });

    if (result.token) {
        localStorage.setItem(AUTH_TOKEN_KEY, result.token);
    }

    return result;
}

/**
 * Clear local session
 */
export function logout() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated() {
    return !!localStorage.getItem(AUTH_TOKEN_KEY);
}
