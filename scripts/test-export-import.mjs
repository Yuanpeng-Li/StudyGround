// Verify: export → file → import round-trip via fetch (browser-equivalent).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SRC_SLUG = 'transformers-from-scratch';

console.log('1. GET /api/tracks/' + SRC_SLUG + '/export');
const expResp = await fetch(`http://localhost:4321/api/tracks/${SRC_SLUG}/export`);
if (!expResp.ok) { console.log('export failed:', expResp.status); process.exit(1); }
const buf = Buffer.from(await expResp.arrayBuffer());
console.log('   size:', buf.length, 'bytes');
await writeFile('/tmp/sg-export-fetch.tgz', buf);

console.log('2. POST /api/tracks/import (binary)');
const impResp = await fetch('http://localhost:4321/api/tracks/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip' },
  body: buf,
});
const result = await impResp.json();
console.log('   status:', impResp.status, 'body:', result);

console.log('3. Verify track list');
const listResp = await fetch('http://localhost:4321/api/tracks').then((r) => r.json());
for (const t of listResp.tracks) {
  console.log(`   - ${t.slug} (${t.lesson_count}L · ${t.material_count}M)`);
}

if (result.ok && result.slug) {
  console.log('4. Spot-check imported lessons');
  const imp = await fetch(`http://localhost:4321/api/lessons?track=${encodeURIComponent(result.slug)}`).then((r) => r.json());
  console.log('   lessons:', imp.lessons);
}
