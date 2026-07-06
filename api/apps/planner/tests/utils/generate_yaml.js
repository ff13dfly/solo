const fs = require('fs');
const path = require('path');

// Configuration references data.md logic
const DEF = {
  entities: [
    { name: 'warehouse', fields: ['name', 'location', 'area', 'rent'] },
    { name: 'section', fields: ['warehouseId', 'name', 'area', 'drawing'] },
    { name: 'unit', fields: ['sectionId', 'name', 'size', 'drawing'] },
    { name: 'stuff', fields: ['unitId', 'name', 'amount', 'price', 'categories'] }
  ],
  standardActions: ['add', 'get', 'update', 'remove', 'list', 'restore']
};

const OUT_DIR = path.join(__dirname, '../cases');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function generateUnitTests() {
  const cases = [];
  let counter = 1;

  DEF.entities.forEach(ent => {
    DEF.standardActions.forEach(act => {
      const id = `${ent.name.substring(0, 1).toUpperCase()}-${act.toUpperCase()}-${String(counter).padStart(2, '0')}`;
      const method = `asset.${ent.name}.${act}`;
      
      const tc = {
        id,
        method,
        desc: `Standard ${act} for ${ent.name}`,
        input: generateInput(ent, act),
        expect: { ok: true }
      };

      if (act === 'add') {
        tc.expect.assert = [
          { field: 'id', match: '^[1-9A-HJ-NP-Za-km-z]{8}$' },
          { field: 'status', equals: 'ACTIVE' }
        ];
      }

      cases.push(tc);
      counter++;
    });
  });

  return dumpYaml(cases);
}

function generateInput(ent, act) {
  if (act === 'add') {
    const input = { name: `Test ${ent.name}` };
    if (ent.name === 'warehouse') input.location = { city: 'Test City' };
    if (ent.name === 'stuff') { input.amount = 10; input.price = 100; }
    return input;
  }
  if (act === 'update') return { id: '${PREV.result.id}', name: `Updated ${ent.name}` };
  if (act === 'remove' || act === 'get' || act === 'restore') return { id: '${PREV.result.id}' };
  if (act === 'list') return {};
  return {};
}

function dumpYaml(obj) {
  // Simple YAML dumper to avoid dependencies
  return obj.map(item => {
    let lines = [`- id: ${item.id}`];
    lines.push(`  method: ${item.method}`);
    lines.push(`  desc: "${item.desc}"`);
    lines.push(`  input: ${JSON.stringify(item.input)}`);
    lines.push(`  expect: ${JSON.stringify(item.expect)}`);
    return lines.join('\n');
  }).join('\n\n');
}

// Generate Files
fs.writeFileSync(path.join(OUT_DIR, 'unit.yaml'), generateUnitTests());
console.log('Generated unit.yaml');

// Skeleton for others
fs.writeFileSync(path.join(OUT_DIR, 'boundary.yaml'), '# Generated Boundary Tests\n');
console.log('Generated boundary.yaml');
