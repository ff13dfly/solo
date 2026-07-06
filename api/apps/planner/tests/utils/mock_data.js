/**
 * Mock Data Seeder for Asset Service
 * 
 * Usage: node api/asset/tests/utils/mock_data.js
 * 
 * This script seeds the database with a realistic "Warehouse -> Section -> Unit -> Stuff" hierarchy.
 * Useful for:
 * 1. Manual API testing (Postman/Curl)
 * 2. Frontend integration testing
 * 3. Search & Aggregation demos
 */

const http = require('http');

// Config
const PORT = 3810;
const ENDPOINT = 'http://localhost:' + PORT;

// Data Templates
const WAREHOUSE = {
  name: "East Coast Fulfillment Center",
  desc: ["Primary Hub", "24/7 Ops"],
  location: { country: "China", province: "Shanghai", city: "Pudong", address: "88 Zhangjiang Hi-Teck Park" },
  area: 12000,
  rent: true,
  category: { TYPE: "WH_LARGE" }
};

const SECTION = {
  name: "Zone A - Cold Chain",
  desc: ["Temp < 0C", "Food & Bev"],
  area: 1500,
  drawing: { range: [[0,0,0], [20,0,0], [20,20,0], [0,20,0]], position: [0,0,0] }
};

const UNIT = {
  name: "Rack A-01",
  size: [2.5, 4.0, 1.2] // W, H, D
};

const STUFF_LIST = [
  { name: "Frozen Salmon", amount: 50, price: 12000, categories: { TYPE: "FOOD", BRAND: "NORWAY" } },
  { name: "Ice Cream Tub", amount: 200, price: 4500, categories: { TYPE: "FOOD" } },
  { name: "Wagyu Beef", amount: 10, price: 80000, categories: { TYPE: "FOOD", GRADE: "A5" } }
];

// JSON-RPC Client Wrapper
async function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() });
    const req = http.request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
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
    console.log(`🔌 Connecting to ${ENDPOINT}...`);

    // 1. Create Warehouse
    console.log('📦 Creating Warehouse...');
    const wh = await call('asset.warehouse.add', WAREHOUSE);
    console.log(`   -> Created: ${wh.name} (${wh.id})`);

    // 2. Create Section
    console.log('🏗️  Creating Section...');
    const sec = await call('asset.section.add', { ...SECTION, warehouseId: wh.id });
    console.log(`   -> Created: ${sec.name} (${sec.id})`);

    // 3. Create Unit
    console.log('🪜 Creating Unit...');
    const unit = await call('asset.unit.add', { ...UNIT, sectionId: sec.id });
    console.log(`   -> Created: ${unit.name} (${unit.id})`);

    // 4. Batch Create Stuff
    console.log('🍎 Batch Creating Stuff...');
    for (const item of STUFF_LIST) {
      // 4a. Create Stuff (Loose)
      const stuff = await call('asset.stuff.add', item);
      
      // 4b. Relocate to Unit (This triggers warehouseId/sectionId backfill)
      const moved = await call('asset.stuff.relocate', { id: stuff.id, newUnitId: unit.id });
      
      console.log(`   -> Added: ${moved.name} (Qty: ${moved.amount}) -> Unit: ${moved.unitId}`);
    }

    console.log('\n✅ Mock Data Seeded Successfully!');
    console.log(`Test ID Reference: Warehouse=${wh.id}, Section=${sec.id}, Unit=${unit.id}`);

  } catch (err) {
    console.error('\n❌ Error Seeding Data:', err);
    process.exit(1);
  }
}

main();
