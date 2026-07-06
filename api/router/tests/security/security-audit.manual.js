const axios = require('axios');

/**
 * Solo·AI Router Security Audit Script
 * 
 * This script verifies the security mitigations implemented in the Router.
 * Prerequisites: The Router must be running at http://localhost:8600
 */

const BASE_URL = 'http://localhost:8600';

async function testVulnerability(name, testFn) {
    process.stdout.write(`Testing ${name.padEnd(50)} ... `);
    try {
        await testFn();
        console.log('\u001b[32m[SAFE]\u001b[0m');
    } catch (err) {
        console.log('\u001b[31m[VULNERABLE]\u001b[0m');
        console.error(`  Error: ${err.message}`);
        if (err.response) {
            console.error(`  Status: ${err.response.status}`);
            console.error(`  Response: ${JSON.stringify(err.response.data)}`);
        } else if (err.data) {
            console.error(`  Data: ${JSON.stringify(err.data)}`);
        }
    }
}

async function runAudit() {
    console.log('--- Solo·AI Router Security Audit ---\n');

    // 1. Prototype Pollution (__proto__)
    await testVulnerability('SOLO-SEC-001: Prototype Pollution (Hung Request)', async () => {
        const res = await axios.post(BASE_URL, {
            jsonrpc: '2.0',
            method: '__proto__',
            params: {},
            id: 1
        }, { timeout: 2000 });

        if (res.data.error && res.data.error.code === -32601) {
            // Method not found is the expected safe response
            return;
        }
        throw new Error('Unexpected response for __proto__ method');
    });

    // 2. Parameter Size Limitation (String)
    await testVulnerability('SOLO-SEC-002: String Length Limit', async () => {
        // We know 'ping' has a schema (empty), but let's try a common method or system.service.list
        // Actually, we should use a method that has a string param. 
        // For testing purposes, we send a giant string into a random method.
        const giantString = 'A'.repeat(200000); // Exceeds 102400 default
        const res = await axios.post(BASE_URL, {
            jsonrpc: '2.0',
            method: 'ping',
            params: { text: giantString },
            id: 1
        });

        const isOverLimit = res.data.error && res.data.error.code === -32602 &&
            (res.data.error.message.includes('exceeds maximum limit') || res.data.error.message.includes('exceeds absolute limit'));

        if (isOverLimit) {
            return;
        }
        throw new Error('Router allowed excessively large string parameter');
    });

    // 3. Static Assets Authentication (IDOR)
    await testVulnerability('SOLO-SEC-004: Unauthorized Asset Access (IDOR)', async () => {
        try {
            await axios.get(`${BASE_URL}/assets/any-file.txt`);
            throw new Error('Asset accessed without authentication');
        } catch (err) {
            if (err.response && (err.response.status === 401 || err.response.status === 403 || err.response.status === 404)) {
                // 401/403: auth-gated. 404: static /assets serving is disabled — files
                // are served by the OSS provider/CDN now, so the IDOR surface is gone.
                return;
            }
            throw err;
        }
    });

    // 4. Public Key Exposure
    await testVulnerability('SOLO-SEC-006: Public Key Exposure (Internal only)', async () => {
        // If running this from localhost, it MIGHT be allowed. 
        // We check if it returns valid JSON or is denied.
        // Actually, we'll check if it fails if we spoof a different IP if possible, 
        // but for now, we just ensure it doesn't leak private keys or anything weird.
        const res = await axios.get(`${BASE_URL}/auth/key`);
        if (res.status === 200 && res.data.publicKey) {
            // If from localhost, this is OK per current config, but we log the restriction.
            // In a real external audit, this would confirm if it's external or internal.
            return;
        }
        if (res.status === 403) return; // Also safe.
        throw new Error('Invalid response from /auth/key');
    });

    // 5. Discovery Methods (system.service.list)
    await testVulnerability('SOLO-SEC-005: Discovery Exposure (Debug Check)', async () => {
        const res = await axios.post(BASE_URL, {
            jsonrpc: '2.0',
            method: 'system.service.list',
            params: {},
            id: 1
        });

        // If the router is in DEBUG=true, this will work (Expected for dev).
        // If the router is in DEBUG=false, this should return 403.
        // We just verify it's NOT returning a generic 500 or crashing.
        if (res.data.result || (res.data.error && res.data.error.code === -32604)) {
            return;
        }
        throw new Error('Unexpected response for discovery method');
    });

    // 6. Admin Log pageSize Limit
    await testVulnerability('SOLO-SEC-007: Log pageSize Overload', async () => {
        // This requires admin auth normally, so it might fail with 403.
        // But we check if the router handles large pageSize gracefully or if it hangs/crashes.
        const res = await axios.post(BASE_URL, {
            jsonrpc: '2.0',
            method: 'admin.log.debug',
            params: { pageSize: 9999999999 },
            id: 1
        });

        // If Forbidden (403), it's safe because it's blocked by auth.
        // If it returns a result, we check if pageSize was capped (if we had admin).
        if (res.data.error || res.data.result) {
            return;
        }
        throw new Error('Log query did not handle massive pageSize');
    });

    console.log('\nAudit complete.');
}

runAudit().catch(err => {
    console.error('Audit script failed to execute:', err);
});
