// --- BROWSER INTERFACE ---

/**
 * Serve a human-readable entry page for the root endpoint.
 * 
 * @param {object} req - Express request object.
 * @param {object} res - Express response object.
 * @param {object} config - Application configuration.
 * 
 * @why Improves developer experience by providing immediate feedback and 
 *      usage examples when the API URL is opened directly in a browser.
 * @attention 
 *   1. PRODUCTION: In non-debug mode, we serve a minimal plain-text response 
 *       to avoid leaking internal structure.
 *   2. EXAMPLES: Provides a copy-pasteable CURL command for quick verification.
 */
function handleRoot(req, res, config) {
    if (!config.debug) {
        return res.status(200).type('text/plain').send('This endpoint is not available for direct access.');
    }

    res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Solo·AI Router</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 40px; max-width: 600px; margin: 0 auto; }
        h1 { color: #4fc3f7; }
        code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
        a { color: #81d4fa; }
        .success { color: #66bb6a; }
        .debug-badge { background: #ff9800; color: #000; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px; }
    </style>
</head>
<body>
    <h1>🚀 Solo·AI Router <span class="debug-badge">DEBUG</span></h1>
    <p class="success">✓ Router is active and listening</p>
    <hr>
    <p>This is a <strong>JSON-RPC 2.0 API gateway</strong>. It does not serve dynamic web content.</p>
    <p><strong>Primary Interface:</strong></p>
    <ul>
        <li>POST <code>/</code> - Universal RPC Gateway</li>
        <li>GET <code>/auth/key</code> - Retrieve Router Public Key</li>
    </ul>
    <p><strong>Quick Test (CURL):</strong></p>
    <pre style="background:#1a1a1a;padding:12px;border-radius:6px;overflow-x:auto;">curl -X POST ${req.protocol}://${req.get('host')}/ \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"system.capability.list","params":{},"id":1}'</pre>
    <hr>
    <p>📚 <a href="https://ff13dfly.github.io/SoloMind/" target="_blank">Documentation</a></p>
</body>
</html>
    `.trim());
}

module.exports = { handleRoot };
