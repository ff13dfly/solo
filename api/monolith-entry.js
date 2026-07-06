const { fork } = require('child_process');
const path = require('path');

/**
 * Monolith Entry Point
 * 
 * This script is intended to be bundled by esbuild for the Solo·AI consolidated system.
 * It provides a way to run all services from a single file.
 */

// We use relative paths for bundling
const services = [
  { name: 'router', entry: './router/index.js' },
  { name: 'administrator', entry: './core/administrator/index.js' },
  { name: 'user', entry: './core/user/index.js' },
  { name: 'agent', entry: './core/agent/index.js' },
  { name: 'gateway', entry: './core/gateway/index.js' },
  { name: 'orchestrator', entry: './core/orchestrator/index.js' },
  { name: 'storage', entry: './apps/storage/index.js' },
  { name: 'fulfillment', entry: './apps/fulfillment/index.js' },
  { name: 'planner', entry: './apps/planner/index.js' },
  { name: 'notification', entry: './core/notification/index.js' },
  { name: 'nexus', entry: './core/nexus/index.js' },
  { name: 'ingress', entry: './core/ingress/index.js' },
  { name: 'mcp', entry: './core/mcp/index.js' },
  { name: 'approval', entry: './apps/approval/index.js' }
];

console.log('🚀 Starting Solo·AI Consolidated System...');

/**
 * Since many services use process.cwd() or relative requires,
 * and we want to keep them somewhat isolated, 
 * we use child_process.fork pointing to the SAME bundled file but with different env vars.
 * 
 * IF we are in the main bundle process, we spawn forks.
 * IF we are in a fork, we run the specific service logic.
 */

const mode = process.env.SOLO_SERVICE;

if (!mode) {
  // MASTER PROCESS: Spawn all services
  services.forEach(service => {
    console.log(`[Master] Spawning ${service.name}...`);
    const child = fork(__filename, [], {
      env: {
        ...process.env,
        SOLO_SERVICE: service.name,
        DEBUG: 'true'
      }
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[${service.name}] Exited with code ${code}`);
      }
    });
  });

  process.on('SIGINT', () => {
    console.log('\nStopping system...');
    process.exit();
  });
} else {
  // SERVICE PROCESS: Execute service logic
  if (mode === 'router') require('./router/index.js');
  else if (mode === 'administrator') require('./core/administrator/index.js');
  else if (mode === 'user') require('./core/user/index.js');
  else if (mode === 'agent') require('./core/agent/index.js');
  else if (mode === 'gateway') require('./core/gateway/index.js');
  else if (mode === 'orchestrator') require('./core/orchestrator/index.js');
  else if (mode === 'storage') require('./apps/storage/index.js');
  else if (mode === 'fulfillment') require('./apps/fulfillment/index.js');
  else if (mode === 'planner') require('./apps/planner/index.js');
  else if (mode === 'notification') require('./core/notification/index.js');
  else if (mode === 'nexus') require('./core/nexus/index.js');
  else if (mode === 'ingress') require('./core/ingress/index.js');
  else if (mode === 'approval') require('./apps/approval/index.js');
  else {
    console.error(`Unknown service mode: ${mode}`);
    process.exit(1);
  }
}
