const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DOCTOR_SH = path.resolve(__dirname, '../../../deploy/scaffold/doctor.sh');

function makeFixtureProject(envContent, opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-doctor-test-'));
    fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'api', 'publish'), { recursive: true });
    fs.copyFileSync(DOCTOR_SH, path.join(dir, 'deploy', 'doctor.sh'));
    fs.writeFileSync(path.join(dir, '.solo-version'), opts.soloVersion || 'v1.3.5\n');
    fs.writeFileSync(path.join(dir, 'api', 'publish', `solo.${opts.soloVersion || 'v1.3.5'}.js`), '// mock\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    fs.writeFileSync(
        path.join(dir, 'deploy', 'solo-services.json'),
        JSON.stringify([{ name: 'gateway', port: opts.gatewayPort || 19881 }])
    );
    fs.writeFileSync(
        path.join(dir, 'deploy', 'services.json'),
        JSON.stringify([{ name: 'finance', port: opts.appPort || 19882 }])
    );
    fs.writeFileSync(path.join(dir, '.env'), envContent || '');
    return dir;
}

function runDoctor(dir, args = [], extraEnv = {}) {
    const cleanEnv = { ...process.env };
    // Avoid host env leaking into fixture .env assertions
    for (const k of [
        'ASSET_ID_LENGTH', 'STORAGE_PROVIDER', 'OSS_PROVIDER', 'STORAGE_ACCESS',
        'LOCAL_OSS_OUTWARD_ORIGIN', 'LOCAL_OSS_PUBLIC_BASE', 'LOCAL_OSS_PUBLIC_READ',
        'LOCAL_OSS_BUCKET', 'AI_PROVIDER', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL',
        'OLLAMA_KEEP_ALIVE', 'OLLAMA_TIMEOUT_MS', 'SOLO_AGENT_PEER_URL',
        'SOLO_AGENT_PEER_TIMEOUT_MS', 'NODE_ENV', 'CORS_ORIGINS', 'ROUTER_PUBLIC_URL',
        'REDIS_URL', 'REDIS_PASSWORD'
    ]) {
        delete cleanEnv[k];
    }
    return new Promise((resolve, reject) => {
        const child = spawn('bash', [path.join(dir, 'deploy', 'doctor.sh'), ...args], {
            cwd: dir,
            env: { ...cleanEnv, ...extraEnv }
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

function startServer(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, () => {
            const addr = srv.address();
            resolve({ server: srv, port: addr.port, url: `http://127.0.0.1:${addr.port}` });
        });
    });
}

describe('deploy/scaffold/doctor.sh cross-box manifest & probes', () => {
    const tempDirs = [];
    const servers = [];

    afterEach(async () => {
        while (servers.length) {
            const s = servers.pop();
            await new Promise((r) => s.close(r));
        }
        while (tempDirs.length) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    test('--json outputs structured manifest and redacts all secrets & URL credentials', async () => {
        const secrets = [
            'SUPER_SECRET_REDIS_PASS_991',
            'SUPER_SECRET_OSS_HMAC_882',
            'sk-openai-secret-773',
            'AIzaGeminiSecret664',
            'sk-dashscope-555',
            'fl_peer_tok_444',
            'peer_pwd_333',
            'user_pass_in_url_222'
        ];
        const env = [
            'NODE_ENV=production',
            'ASSET_ID_LENGTH=16',
            'STORAGE_PROVIDER=local',
            'STORAGE_ACCESS=private',
            'LOCAL_OSS_BUCKET=solo',
            `LOCAL_OSS_SECRET=${secrets[1]}`,
            'LOCAL_OSS_OUTWARD_ORIGIN=https://u1:user_pass_in_url_222@finance.w3os.net/_oss',
            `REDIS_PASSWORD=${secrets[0]}`,
            `OPENAI_API_KEY=${secrets[2]}`,
            `GEMINI_API_KEY=${secrets[3]}`,
            `DASHSCOPE_API_KEY=${secrets[4]}`,
            'AI_PROVIDER=ollama',
            'OLLAMA_BASE_URL=http://user:user_pass_in_url_222@127.0.0.1:11434',
            'OLLAMA_MODEL=qwen3.5:9b',
            'OLLAMA_KEEP_ALIVE=-1',
            'OLLAMA_TIMEOUT_MS=120000',
            'SOLO_AGENT_PEER_URL=https://peer:user_pass_in_url_222@catalog-api.w3os.net/jsonrpc',
            `SOLO_AGENT_PEER_TOKEN=${secrets[5]}`,
            `SOLO_AGENT_PEER_PASSWORD=${secrets[6]}`
        ].join('\n');

        const dir = makeFixtureProject(env);
        tempDirs.push(dir);

        const res = await runDoctor(dir, ['--json']);
        expect(res.status).toBe(0);
        const json = JSON.parse(res.stdout);

        expect(json.soloVersion.expected).toBe('v1.3.5');
        expect(json.assetIdLength).toEqual({ value: 16, explicit: true });
        expect(json.storage).toMatchObject({
            provider: 'local',
            access: 'private',
            localPublicRead: false,
            bucket: 'solo',
            outwardOrigin: 'https://finance.w3os.net/_oss'
        });
        expect(json.agent).toMatchObject({
            provider: 'ollama',
            ollamaBaseUrl: 'http://127.0.0.1:11434',
            ollamaModel: 'qwen3.5:9b',
            ollamaKeepAlive: '-1',
            ollamaKeepAliveExplicit: true,
            ollamaTimeoutMs: 120000,
            peerAgentUrl: 'https://catalog-api.w3os.net/jsonrpc'
        });
        expect(json.services.map((s) => s.name)).toEqual(['solo:gateway', 'app:finance']);

        for (const s of secrets) {
            expect(res.stdout).not.toContain(s);
            expect(res.stderr).not.toContain(s);
        }
    });

    test('STORAGE_PROVIDER=aliyun does not trigger local outwardOrigin warning', async () => {
        const dir = makeFixtureProject([
            'NODE_ENV=production',
            'STORAGE_PROVIDER=aliyun',
            'STORAGE_ACCESS=private'
        ].join('\n'));
        tempDirs.push(dir);

        const res = await runDoctor(dir, ['--json']);
        expect(res.status).toBe(0);
        const json = JSON.parse(res.stdout);
        expect(json.storage.provider).toBe('aliyun');
        expect(json.checks.some((c) => c.message.includes('LOCAL_OSS_OUTWARD_ORIGIN'))).toBe(false);
    });

    test('outward /_oss/* probe succeeds on healthy private oss and fails on unstripped prefix or HTML error', async () => {
        const healthy = await startServer((req, res) => {
            if (req.url === '/_oss/') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('local-oss');
                return;
            }
            if (req.url === '/_oss/solo/__doctor_probe__') {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 'AccessDenied', status: 403, message: 'AccessDenied' }));
                return;
            }
            res.writeHead(404).end();
        });
        servers.push(healthy.server);

        const unstripped = await startServer((req, res) => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'NoSuchBucket', status: 404, message: 'NoSuchBucket' }));
        });
        servers.push(unstripped.server);

        const htmlErr = await startServer((req, res) => {
            res.writeHead(502, { 'Content-Type': 'text/html' });
            res.end('<html><body>502 Bad Gateway</body></html>');
        });
        servers.push(htmlErr.server);

        // Use http://[::1] or mock host? Wait: 127.0.0.1 is filtered as loopback in doctor.sh!
        // Use http://localhost? Also filtered. Use http://localtest.me or 127.0.0.2 (Wait: 127.0.0.2 matches ^https?://127\.).
        // Let's test via 0.0.0.0? Also filtered. Wait: how can we test non-loopback in unit test without DNS?
        // In Node fetch, we can't resolve arbitrary domain offline, UNLESS we pass a non-127 IPv4 like 127.x? No, 127.x is filtered.
        // What about http://[::ffff:127.0.0.1]:port ? Let's check if regex matches it: ^https?://(127\.|localhost|0\.0\.0\.0|\[::1\])
        // [::ffff:127.0.0.1] does NOT match that regex, and Node's fetch connects to loopback 127.0.0.1!
        const toV4Mapped = (u) => u.replace('127.0.0.1', '[::ffff:127.0.0.1]');

        const dirOk = makeFixtureProject([
            'NODE_ENV=production',
            'STORAGE_PROVIDER=local',
            'STORAGE_ACCESS=private',
            `LOCAL_OSS_OUTWARD_ORIGIN=${toV4Mapped(healthy.url)}/_oss`
        ].join('\n'));
        tempDirs.push(dirOk);
        const resOk = await runDoctor(dirOk, ['--json'], { DOCTOR_PROBE_OUTWARD: '1' });
        expect(resOk.status).toBe(0);
        const jOk = JSON.parse(resOk.stdout);
        expect(jOk.storage.outwardProbe).toMatchObject({ ok: true, status: 403, kind: 'ok' });

        const dirBadPrefix = makeFixtureProject([
            'NODE_ENV=production',
            'STORAGE_PROVIDER=local',
            'STORAGE_ACCESS=private',
            `LOCAL_OSS_OUTWARD_ORIGIN=${toV4Mapped(unstripped.url)}/_oss`
        ].join('\n'));
        tempDirs.push(dirBadPrefix);
        const resBadPrefix = await runDoctor(dirBadPrefix, ['--json'], { DOCTOR_PROBE_OUTWARD: '1' });
        expect(resBadPrefix.status).toBe(1);
        const jBadPrefix = JSON.parse(resBadPrefix.stdout);
        expect(jBadPrefix.storage.outwardProbe).toMatchObject({ ok: false, kind: 'bad' });
        expect(jBadPrefix.storage.outwardProbe.detail).toContain('NoSuchBucket');

        const dirHtml = makeFixtureProject([
            'NODE_ENV=production',
            'STORAGE_PROVIDER=local',
            'STORAGE_ACCESS=private',
            `LOCAL_OSS_OUTWARD_ORIGIN=${toV4Mapped(htmlErr.url)}/_oss`
        ].join('\n'));
        tempDirs.push(dirHtml);
        const resHtml = await runDoctor(dirHtml, ['--json'], { DOCTOR_PROBE_OUTWARD: '1' });
        expect(resHtml.status).toBe(1);
        const jHtml = JSON.parse(resHtml.stdout);
        expect(jHtml.storage.outwardProbe).toMatchObject({ ok: false, kind: 'bad', status: 502 });
    });

    test('ollama keep-alive warning & peer agent JSON-RPC ping probe', async () => {
        const ollamaMock = await startServer((req, res) => {
            if (req.url === '/api/tags') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }));
                return;
            }
            res.writeHead(404).end();
        });
        servers.push(ollamaMock.server);

        const peerMock = await startServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
        });
        servers.push(peerMock.server);

        const dir = makeFixtureProject([
            'AI_PROVIDER=ollama',
            `OLLAMA_BASE_URL=${ollamaMock.url}`,
            'OLLAMA_KEEP_ALIVE=5m',
            `SOLO_AGENT_PEER_URL=${peerMock.url}/jsonrpc`
        ].join('\n'));
        tempDirs.push(dir);

        const res = await runDoctor(dir, ['--json'], { DOCTOR_PROBE_AGENT: '1' });
        expect(res.status).toBe(0);
        const json = JSON.parse(res.stdout);
        expect(json.agent.ollamaProbe).toMatchObject({ ok: true, models: 1 });
        expect(json.agent.peerProbe).toMatchObject({ ok: true, status: 200 });
        expect(json.checks.some((c) => c.level === 'warn' && c.message.includes('OLLAMA_KEEP_ALIVE'))).toBe(true);
    });
});
