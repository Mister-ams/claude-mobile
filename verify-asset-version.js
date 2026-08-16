#!/usr/bin/env node
// index.html loads /app.js with a ?v=<version> cache-bust query. iOS Safari
// serves stale assets across a pm2 restart even under no-cache headers
// (HANDOVER.md), so that query is what actually busts it -- and it is only
// useful if it tracks package.json. This asserts they match; wire it into CI
// so a version bump that forgets index.html fails loudly instead of shipping
// a client that never updates.
const fs = require('fs');
const path = require('path');

const root = __dirname;
const version = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
).version;
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const m = /\/app\.js\?v=([^"']+)/.exec(html);
if (!m) {
  console.error('FAIL: public/index.html does not load /app.js with a ?v= query');
  process.exit(1);
}
if (m[1] !== version) {
  console.error(
    `FAIL: asset query v=${m[1]} does not match package.json version ${version}`
  );
  process.exit(1);
}
console.log(`asset version OK: ${version}`);
