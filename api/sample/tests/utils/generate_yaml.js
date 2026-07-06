const fs = require('fs');
const path = require('path');

// Generates data-driven YAML test cases (see ../cases.md) for THIS service's surface.
// Mirrors handlers/introspection.js — when you copy the template, replace these entities
// + create payloads with your own (the rest of the generator stays the same).
const PREFIX = 'sample';
const DEF = {
  entities: [
    { name: 'item',     actions: ['create', 'get', 'update', 'delete', 'restore', 'list'], create: { name: 'Test Item', description: 'seeded by generate_yaml' }, hasStatus: true },
    { name: 'category', actions: ['create', 'get', 'update', 'delete', 'list'],            create: { name: 'Test Category' },                                       hasStatus: false },
  ],
};

const OUT_DIR = path.join(__dirname, '../cases');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function generateInput(ent, act) {
  if (act === 'create') return ent.create;
  if (act === 'update') return { id: '${PREV.result.id}', name: `Updated ${ent.name}` };
  if (act === 'get' || act === 'delete' || act === 'restore') return { id: '${PREV.result.id}' };
  return {}; // list
}

function generateUnitTests() {
  const cases = [];
  let counter = 1;

  DEF.entities.forEach(ent => {
    ent.actions.forEach(act => {
      const id = `${ent.name[0].toUpperCase()}-${act.toUpperCase()}-${String(counter).padStart(2, '0')}`;
      const tc = {
        id,
        method: `${PREFIX}.${ent.name}.${act}`,
        desc: `Standard ${act} for ${ent.name}`,
        input: generateInput(ent, act),
        expect: { ok: true },
      };

      if (act === 'create') {
        tc.expect.assert = [{ field: 'id', match: '^[1-9A-HJ-NP-Za-km-z]{4,}$' }];
        if (ent.hasStatus) tc.expect.assert.push({ field: 'status', equals: 'ACTIVE' });
      }

      cases.push(tc);
      counter++;
    });
  });

  return dumpYaml(cases);
}

function dumpYaml(obj) {
  // Minimal YAML dumper to avoid dependencies.
  return obj.map(item => [
    `- id: ${item.id}`,
    `  method: ${item.method}`,
    `  desc: "${item.desc}"`,
    `  input: ${JSON.stringify(item.input)}`,
    `  expect: ${JSON.stringify(item.expect)}`,
  ].join('\n')).join('\n\n');
}

// Generate Files
fs.writeFileSync(path.join(OUT_DIR, 'unit.yaml'), generateUnitTests());
console.log('Generated unit.yaml');

// Skeleton for others
fs.writeFileSync(path.join(OUT_DIR, 'boundary.yaml'), '# Generated Boundary Tests\n');
console.log('Generated boundary.yaml');
