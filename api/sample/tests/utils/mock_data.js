/**
 * Mock Data Seeder (template) — seeds THIS service's own entities (a category + a few
 * items, then attaches the items to the category) over JSON-RPC. For manual UI/API
 * testing, frontend integration, and search/aggregation demos.
 *
 * Usage: node tests/utils/mock_data.js     (the service must be running)
 *
 * Goes DIRECT to the service (no Router / no auth — dev seeding only). When you copy the
 * template, point SAMPLE_URL at your service and swap the entity payloads for your own.
 */
const http = require('http');

// Direct service endpoint. Override with SAMPLE_URL; default mirrors config.js portFor('sample', 8999).
const SERVICE_URL = process.env.SAMPLE_URL || `http://localhost:${process.env.PORT || 8999}`;

// Data templates — fields mirror handlers/introspection.js (item: name + description; category: key).
const CATEGORY = { key: 'DEMO' };
const ITEMS = [
  { name: 'Alpha Widget', description: 'first demo item' },
  { name: 'Beta Widget',  description: 'second demo item' },
  { name: 'Gamma Widget', description: 'third demo item' },
];

// JSON-RPC Client Wrapper
async function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() });
    const req = http.request(SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(json.error);
          else resolve(json.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Execution Flow
async function main() {
  try {
    console.log(`🔌 Connecting to ${SERVICE_URL}...`);

    // 1. Create a category. NOTE: category.create reserves the key globally in the Router
    //    (federated), so the Router must be up — the service makes that outbound call itself.
    console.log('🗂️  Creating category...');
    const cat = await call('sample.category.create', CATEGORY);
    console.log(`   -> category ${cat.key} (${cat.type}/${cat.scope})`);

    // 2. Create items, then attach each to the category. category.item.add keys off the
    //    category `key` + the item `id`, with `label` for display (mirrors library/category.js).
    console.log('📦 Creating items + attaching to category...');
    for (const it of ITEMS) {
      const item = await call('sample.item.create', it);
      await call('sample.category.item.add', { key: cat.key, id: item.id, label: item.name });
      console.log(`   -> ${item.name} (${item.id})`);
    }

    console.log('\n✅ Mock Data Seeded Successfully!');
    console.log(`Reference: category=${cat.key}`);
  } catch (err) {
    console.error('\n❌ Error Seeding Data:', err);
    process.exit(1);
  }
}

main();
