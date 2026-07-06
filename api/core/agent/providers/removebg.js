const https = require('https');
const { createLogger } = require('../../../library/logger');

const logger = createLogger('agent');

/**
 * Remove.bg Provider
 * @why Dedicated background-removal service. Handles psImage for the agent.
 *      API key configured via REMOVE_BG_API_KEY env var.
 *      Accepts base64 image, returns base64 PNG with background removed.
 */
class RemoveBgProvider {
    constructor(config) {
        this.config = config;
        this.apiKey = config.removeBgApiKey;
    }

    async psImage({ image }) {
        logger.info('[RemoveBg] Removing background...');
        if (!this.apiKey) throw new Error('Missing REMOVE_BG_API_KEY');

        // Strip data URI prefix if present
        const base64 = image.replace(/^data:image\/\w+;base64,/, '');

        const payload = JSON.stringify({
            image_file_b64: base64,
            size: 'auto',
        });

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.remove.bg',
                path: '/v1.0/removebg',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': this.apiKey,
                    'Content-Length': Buffer.byteLength(payload),
                },
            };

            const req = https.request(options, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const contentType = res.headers['content-type'] || '';

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        // Successful response is raw PNG binary
                        const resultBase64 = buf.toString('base64');
                        resolve({
                            success: true,
                            image: resultBase64,
                            mimeType: 'image/png',
                            metadata: { provider: 'removebg' },
                        });
                    } else {
                        // Error response is JSON
                        let errMsg = `remove.bg API error: ${res.statusCode}`;
                        try {
                            const json = JSON.parse(buf.toString());
                            errMsg = json.errors?.[0]?.title || errMsg;
                        } catch (_) { /* ignore */ }
                        logger.error('[RemoveBg] Error:', errMsg);
                        reject(new Error(errMsg));
                    }
                });
            });

            req.setTimeout(30000, () => req.destroy(new Error('remove.bg timeout after 30s')));
            req.on('error', (e) => { e._isNetwork = true; reject(e); });
            req.write(payload);
            req.end();
        });
    }
}

module.exports = RemoveBgProvider;
