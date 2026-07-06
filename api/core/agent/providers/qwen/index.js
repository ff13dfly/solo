const https = require('https');
const { createLogger } = require('../../../../library/logger');
const { DASHSCOPE_BASE_URL } = require('./constants');

const text = require('./text');
const vision = require('./vision');
const intent = require('./intent');
const tools = require('./tools');
const generation = require('./generation');
const audio = require('./audio');

const logger = createLogger('agent');

class QwenProvider {
    constructor(config) {
        this.config = config;
        this.apiKey = config.qwenApiKey;
    }

    async _callApi(path, body, model, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            if (!this.apiKey) return reject(new Error('Missing DashScope API Key'));

            const payload = JSON.stringify({
                model: model,
                input: body.input,
                parameters: body.parameters || {}
            });
            const options = {
                hostname: DASHSCOPE_BASE_URL,
                path: path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Length': Buffer.byteLength(payload),
                    ...extraHeaders,
                }
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(response);
                        } else {
                            reject(new Error(JSON.stringify(response) || `API Error: ${res.statusCode}`));
                        }
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${data}`));
                    }
                });
            });
            req.setTimeout(60000, () => req.destroy(new Error('DashScope API timeout after 60s')));
            req.on('error', (e) => { e._isNetwork = true; reject(e); });
            req.write(payload);
            req.end();
        });
    }

    /** Poll a DashScope async task until SUCCEEDED / FAILED (max 90s) */
    async _pollTask(taskId, { pollInterval = 2000, maxWait = 90000 } = {}) {
        const { TASK_QUERY_API } = require('./constants');
        const deadline = Date.now() + maxWait;

        const query = () => new Promise((resolve, reject) => {
            const options = {
                hostname: DASHSCOPE_BASE_URL,
                path: `${TASK_QUERY_API}/${taskId}`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error(`Invalid task response: ${data}`)); }
                });
            });
            req.setTimeout(15000, () => req.destroy(new Error('Task query timeout')));
            req.on('error', reject);
            req.end();
        });

        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, pollInterval));
            const res = await query();
            const status = res.output?.task_status;
            if (status === 'SUCCEEDED') return res;
            if (status === 'FAILED') throw new Error(res.output?.message || `Wanxiang task failed: ${taskId}`);
            // PENDING / RUNNING → keep polling
        }
        throw new Error(`Wanxiang task timeout (${taskId})`);
    }
}

Object.assign(QwenProvider.prototype, text, vision, intent, tools, generation, audio);

module.exports = QwenProvider;
