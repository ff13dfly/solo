const https = require('https');
const http = require('http');

/**
 * RMBG: Background removal via local ONNX server with cloud API fallback.
 *
 * Priority:
 *   1. Local RMBG server (RMBG_LOCAL_URL env, default http://localhost:3099)
 *   2. Remove.bg cloud API (REMOVEBG_API_KEY env, if set)
 *   3. Error — no provider available
 */

const LOCAL_URL  = process.env.RMBG_LOCAL_URL || 'http://localhost:3099';
const LOCAL_TIMEOUT_MS = 60000;

async function cutoutLocal(imageBase64) {
    const url = new URL('/rmbg', LOCAL_URL);
    const body = JSON.stringify({ image: imageBase64 });
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = lib.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: LOCAL_TIMEOUT_MS
        }, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Local RMBG returned ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                } catch (e) {
                    reject(new Error('Local RMBG response parse failed'));
                }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Local RMBG timeout')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function cutoutRemoveBg(imageBase64) {
    const apiKey = process.env.REMOVEBG_API_KEY;
    if (!apiKey) throw new Error('REMOVEBG_API_KEY not configured');

    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const boundary = `----FormBoundary${Date.now()}`;
    const parts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
        imageBuffer,
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\nauto\r\n--${boundary}--\r\n`
    ];
    const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));

    return new Promise((resolve, reject) => {
        const req = https.request('https://api.remove.bg/v1.0/removebg', {
            method: 'POST',
            headers: {
                'X-Api-Key': apiKey,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`remove.bg returned ${res.statusCode}`));
                }
                resolve({ image: Buffer.concat(chunks).toString('base64'), provider: 'removebg' });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function cutout(params) {
    const { image } = params;
    if (!image) throw new Error('Missing required field: image (base64)');

    // Try local first
    try {
        const result = await cutoutLocal(image);
        return { ...result, provider: 'local' };
    } catch (localErr) {
        console.warn(`[gateway/rmbg] Local unavailable (${localErr.message}), falling back to cloud`);
    }

    // Fallback to remove.bg
    try {
        return await cutoutRemoveBg(image);
    } catch (cloudErr) {
        throw new Error(`RMBG failed: local unavailable, cloud error: ${cloudErr.message}`);
    }
}

module.exports = { cutout };
