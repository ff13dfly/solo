/** Hermetic: shared /health (liveness) + /readyz (readiness) handlers. */
const { mountHealth } = require('../health');

function fakeApp() {
    const routes = {};
    return { get(path, h) { routes[path] = h; }, _routes: routes };
}
function fakeRes() {
    const r = { _status: 200, _json: null, status(c) { r._status = c; return r; }, json(j) { r._json = j; return r; } };
    return r;
}

describe('library/health', () => {
    test('/health — always live (200 ok), echoes service + version', () => {
        const app = fakeApp();
        mountHealth(app, { serviceName: 'svc', version: '1.0.0', getRedis: () => null });
        const res = fakeRes();
        app._routes['/health']({}, res);
        expect(res._json).toMatchObject({ status: 'ok', service: 'svc', version: '1.0.0' });
    });

    test('/readyz — 200 when Redis pings', async () => {
        const app = fakeApp();
        mountHealth(app, { serviceName: 'svc', getRedis: () => ({ async ping() { return 'PONG'; } }) });
        const res = fakeRes();
        await app._routes['/readyz']({}, res);
        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({ status: 'ready', checks: { redis: 'ok' } });
    });

    test('/readyz — 503 when Redis throws', async () => {
        const app = fakeApp();
        mountHealth(app, { serviceName: 'svc', getRedis: () => ({ async ping() { throw new Error('down'); } }) });
        const res = fakeRes();
        await app._routes['/readyz']({}, res);
        expect(res._status).toBe(503);
        expect(res._json).toMatchObject({ status: 'not_ready', checks: { redis: 'down' } });
    });

    test('/readyz — 503 when no Redis client is wired yet', async () => {
        const app = fakeApp();
        mountHealth(app, { serviceName: 'svc', getRedis: () => null });
        const res = fakeRes();
        await app._routes['/readyz']({}, res);
        expect(res._status).toBe(503);
        expect(res._json.checks.redis).toBe('unconfigured');
    });
});

describe('library/health — /metrics (toFix §6.5)', () => {
    function metricsRes() {
        const r = {
            _headers: {}, _body: null,
            set(k, v) { r._headers[k] = v; return r; },
            send(b) { r._body = b; return r; },
        };
        return r;
    }

    test('base process gauges always present, labeled with the service', async () => {
        const app = fakeApp();
        mountHealth(app, { serviceName: 'svc-m', getRedis: () => null });
        const res = metricsRes();
        await app._routes['/metrics']({}, res);

        expect(res._headers['Content-Type']).toMatch(/text\/plain/);
        expect(res._body).toMatch(/solo_process_uptime_seconds\{service="svc-m"\} [\d.]+/);
        expect(res._body).toMatch(/# TYPE solo_process_heap_used_bytes gauge/);
        expect(res._body).toMatch(/solo_process_rss_bytes\{service="svc-m"\} \d+/);
    });

    test('getMetrics gauges appended with merged labels', async () => {
        const app = fakeApp();
        mountHealth(app, {
            serviceName: 'svc-q', getRedis: () => null,
            getMetrics: async () => [
                { name: 'solo_dlq_depth', value: 7, help: 'dlq', labels: { queue: 'q1' } },
            ],
        });
        const res = metricsRes();
        await app._routes['/metrics']({}, res);
        expect(res._body).toContain('solo_dlq_depth{service="svc-q",queue="q1"} 7');
    });

    test('getMetrics failure degrades — base gauges survive, error gauge emitted', async () => {
        const app = fakeApp();
        mountHealth(app, {
            serviceName: 'svc-e', getRedis: () => null,
            getMetrics: async () => { throw new Error('collector broke'); },
        });
        const res = metricsRes();
        await app._routes['/metrics']({}, res);
        expect(res._body).toMatch(/solo_process_uptime_seconds/);
        expect(res._body).toMatch(/solo_metrics_collector_errors\{service="svc-e"\} 1/);
    });

    test('mounted with NO options object — defaults applied across all probes', async () => {
        // Mount with only the app: the entire options bag falls back to `{}`
        // (mountHealth's `{ ... } = {}` default-arg), so serviceName/version/
        // getRedis/getMetrics are all undefined. Nothing must throw.
        const app = fakeApp();
        mountHealth(app);

        // /health answers; service/version are simply absent (undefined).
        const hres = fakeRes();
        app._routes['/health']({}, hres);
        expect(hres._json.status).toBe('ok');
        expect(hres._json.service).toBeUndefined();

        // /readyz: getRedis is not a function → the thunk guard resolves redis to
        // `null` (the `: null` arm) → unconfigured → 503, not a crash.
        const rres = fakeRes();
        await app._routes['/readyz']({}, rres);
        expect(rres._status).toBe(503);
        expect(rres._json.checks.redis).toBe('unconfigured');

        // /metrics: serviceName undefined → the label falls back to "unknown".
        const mres = metricsRes();
        await app._routes['/metrics']({}, mres);
        expect(mres._body).toMatch(/solo_process_uptime_seconds\{service="unknown"\}/);
    });

    test('getMetrics returning undefined degrades to base gauges only (no error gauge)', async () => {
        // A collector that returns nothing (not an array) must not blank the scrape:
        // the `(await getMetrics()) || []` guard substitutes an empty extra list.
        const app = fakeApp();
        mountHealth(app, { serviceName: 'svc-n', getRedis: () => null, getMetrics: async () => undefined });
        const res = metricsRes();
        await app._routes['/metrics']({}, res);
        expect(res._body).toMatch(/solo_process_uptime_seconds\{service="svc-n"\}/);
        // It did NOT throw, so the collector-error gauge must be absent.
        expect(res._body).not.toMatch(/solo_metrics_collector_errors/);
    });

    test('a gauge without `help` falls back to its name in the HELP line', async () => {
        // renderMetric's `help || name`: when a gauge omits help, the metric name
        // is reused as the help text (still a valid Prometheus exposition line).
        const app = fakeApp();
        mountHealth(app, {
            serviceName: 'svc-h', getRedis: () => null,
            getMetrics: async () => [{ name: 'solo_no_help', value: 42 }],   // no help / labels / type
        });
        const res = metricsRes();
        await app._routes['/metrics']({}, res);
        expect(res._body).toContain('# HELP solo_no_help solo_no_help');
        expect(res._body).toContain('# TYPE solo_no_help gauge');           // default type still applied
        expect(res._body).toContain('solo_no_help{service="svc-h"} 42');
    });

    test('a gauge with an explicit `type` overrides the gauge default', async () => {
        // renderMetric's `type = 'gauge'` default is bypassed when a metric declares
        // its own type (e.g. a monotonic counter) — the TYPE line must reflect it.
        const app = fakeApp();
        mountHealth(app, {
            serviceName: 'svc-t', getRedis: () => null,
            getMetrics: async () => [
                { name: 'solo_events_total', value: 5, help: 'events', type: 'counter', labels: { kind: 'x' } },
            ],
        });
        const res = metricsRes();
        await app._routes['/metrics']({}, res);
        expect(res._body).toContain('# TYPE solo_events_total counter');
        expect(res._body).toContain('solo_events_total{service="svc-t",kind="x"} 5');
    });
});
