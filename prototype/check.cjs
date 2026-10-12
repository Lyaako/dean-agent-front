const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const version = JSON.parse(read('references/frontend-source/source.json'));
assert.equal(version.branch, 'react-frontend');
assert.equal(version.commit, '9c68ae0c5f062b87811058599151bc135576b33d');
for (const file of version.prototype_files) {
  assert.equal(digest('prototype/' + file), digest('references/frontend-source/mockup/redesign/' + file), file + ' differs from approved source');
}
const html = read('prototype/index.html');
for (const [i,match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
  if (match[1].trim()) new vm.Script(match[1], {filename:'inline-' + i});
}
for (const file of version.prototype_files.filter(f=>f.endsWith('.js'))) new vm.Script(read('prototype/' + file), {filename:file});
new vm.Script(version.prototype_files.filter(f=>f.endsWith('.js')).map(f=>read('prototype/'+f)).join('\n'),{filename:'combined-mockup.js'});
for (const match of html.matchAll(/(?:src|href)="([^"?#]+)(?:\?[^"#]*)?"/g)) {
  if(!/^(https?:|#)/.test(match[1])) assert(fs.existsSync(path.join(root,'prototype',match[1])), 'Missing asset: '+match[1]);
}
const catalog = JSON.parse(read('docs/resource-catalog.json'));
const schema = read('references/database/01_schema.sql');
const names = [...schema.matchAll(/CREATE TABLE (\w+)/g)].map(m=>m[1]);
assert.equal(catalog.tables.length,56);
assert.deepEqual(catalog.tables.map(t=>t.name).sort(),names.sort());
assert.equal(catalog.tables.reduce((n,t)=>n+t.fields.length,0),312);
assert.equal(catalog.tables.reduce((n,t)=>n+t.fields.filter(f=>f.reference).length,0),83);
assert.equal(catalog.views.length,27);
const byName = new Map(catalog.tables.map(t=>[t.name,t]));
for (const table of catalog.tables) {
  assert(table.key.length);
  for(const key of table.key) assert(table.fields.some(f=>f.name===key));
  for(const field of table.fields.filter(f=>f.reference)) {
    const target = byName.get(field.reference.table);
    assert(target && target.fields.some(f=>f.name===field.reference.column));
  }
}
assert.deepEqual(byName.get('order_student').key,['order_id','student_id']);
assert.deepEqual(byName.get('student_contact').key,['student_id','contact_person_id']);
assert.deepEqual(byName.get('audit_log_detail').key,['audit_id','column_name']);
const api = read('docs/API.md');
for(const route of ['/auth/login','/auth/refresh','/auth/me','/auth/logout','/schema','/resources/{name}','/resources/{table}','/workflows/{name}','/agent/capabilities','/agent/chat/stream','/agent/proposals/{id}','/files','/jobs/{id}','/files/{file_id}/versions/{version_id}/download']) assert(api.includes(route),route);
const tabs = [...read('references/frontend-source/frontend/src/pages/tabs.ts').matchAll(/id: "([^"]+)"/g)].map(m=>m[1]);
assert.deepEqual(tabs,['students','groups','schedule','works','requests','practice','employees','olap']);
for (const file of ['README.md','docs/ARCHITECTURE.md','docs/API.md','docs/FUNCTIONAL_SPEC.md','docs/IMPLEMENTATION_PLAN.md','docs/DATABASE_CATALOG.md','docs/FRONTEND_VERSION.md']) {
  for(const match of read(file).matchAll(/\]\(([^)]+)\)/g)) {
    if(!/^(https?:|#)/.test(match[1])) assert(fs.existsSync(path.resolve(root,path.dirname(file),match[1])),file + ': missing ' + match[1]);
  }
}
for (const file of ['README.md','docs/IMPLEMENTATION_PLAN.md']) assert(read(file).includes(version.commit), 'Wrong version in '+file);
assert(read('docs/API.md').includes('last_name'));
assert(read('references/frontend-source/frontend/src/pages/EmployeesPage.tsx').includes('linked:'));
assert(read('references/frontend-source/frontend/src/api/client.ts').includes('localStorage.setItem(CSRF_KEY'));
console.log('PASS: react-frontend 9c68ae0c; 10 exact assets; all JS syntax; SQL catalogue; keys; API routes; document links.');
