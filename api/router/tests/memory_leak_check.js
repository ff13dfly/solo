const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROUTER_PATH = path.join(__dirname, '../index.js');
const RPC_ENDPOINT = 'http://localhost:8600';
const TOTAL_REQUESTS = 5000;
const CONCURRENCY = 50;
const SAMPLE_INTERVAL = 1000; // Check memory every N requests

function log(msg) {
    console.log(`[LeakTest] ${msg}`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Spawn Router
log('Starting Router process...');
const routerProcess = spawn('node', [ROUTER_PATH], {
    cwd: path.dirname(ROUTER_PATH),
    stdio: ['ignore', 'ignore', 'pipe'], // Ignore stdout, capture stderr for errors
    env: { ...process.env, PORT: '8600' }
});

routerProcess.stderr.on('data', (data) => {
    // console.error(`Router Stderr: ${data}`);
});

// Helper to get memory usage of the child process
// Note: In a real environment we might use 'pidusage', but for a simple script
// we can also rely on the router enforcing garbage collection if we expose an endpoint,
// or just infer from external behavior. 
// However, since we don't have 'pidusage' installed by default, 
// we will use 'process.memoryUsage' from WITHIN the child process if we could, 
// OR we can just observe if it crashes.
// BETTER APPROACH: We'll use `ps` to check RSS of the PID.
const exec = require('child_process').exec;
function getMemory(pid) {
    return new Promise((resolve) => {
        exec(`ps -o rss= -p ${pid}`, (err, stdout) => {
            if (err) return resolve(0);
            resolve(parseInt(stdout.trim()) / 1024); // MB
        });
    });
}

async function waitForRouter() {
    for (let i = 0; i < 20; i++) {
        try {
            await rpcCall('system.service.status', { serviceId: 'router' }); // Dummy call
            return true;
        } catch (e) {
            await sleep(500);
        }
    }
    return false;
}

function rpcCall(method, params = {}) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: Date.now()
        });

        const req = http.request(RPC_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

(async () => {
    try {
        if (!await waitForRouter()) {
            throw new Error('Router failed to start');
        }
        log(`Router started (PID: ${routerProcess.pid}). Warming up...`);
        
        // Initial Memory
        const initialMem = await getMemory(routerProcess.pid);
        log(`Initial Memory (RSS): ${initialMem.toFixed(2)} MB`);

        let completed = 0;
        const start = Date.now();

        // Load Generator
        const runBatch = async () => {
             const batch = [];
             for(let i=0; i<CONCURRENCY; i++) {
                batch.push(rpcCall('admin.log.debug', { page: 1, pageSize: 5 })); // Light read op
             }
             await Promise.all(batch);
             completed += CONCURRENCY;
        };

        log(`Starting load test: ${TOTAL_REQUESTS} requests...`);
        
        while(completed < TOTAL_REQUESTS) {
            await runBatch();
            
            if (completed % SAMPLE_INTERVAL === 0) {
                const mem = await getMemory(routerProcess.pid);
                const progress = ((completed/TOTAL_REQUESTS)*100).toFixed(1);
                log(`[${progress}%] Req: ${completed}, RSS: ${mem.toFixed(2)} MB (Delta: ${(mem - initialMem).toFixed(2)} MB)`);
            }
        }

        const duration = (Date.now() - start) / 1000;
        log(`Load test finished in ${duration.toFixed(2)}s (${(TOTAL_REQUESTS/duration).toFixed(1)} req/s).`);
        
        log('Waiting 5s for GC/Settling...');
        await sleep(5000);

        const finalMem = await getMemory(routerProcess.pid);
        log(`Final Memory (RSS): ${finalMem.toFixed(2)} MB`);
        log(`Net Change: ${(finalMem - initialMem).toFixed(2)} MB`);

        if ((finalMem - initialMem) > 50) {
            log('WARNING: Significant memory increase (>50MB). Potential leak or fragmentation.');
            process.exit(1);
        } else {
            log('PASS: Memory usage stable.');
            process.exit(0);
        }

    } catch (e) {
        console.error(e);
        process.exit(1);
    } finally {
        routerProcess.kill();
    }
})();
