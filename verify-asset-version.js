#!/usr/bin/env node
// index.html loads /app.js and /style.css with a ?v=<version> cache-bust
// query, and setup.html loads /style.css the same way. iOS Safari serves stale
// assets across a pm2 restart even under no-cache headers (HANDOVER.md), so
// that query is what actually busts it -- and it is only useful if it tracks
// package.json. A stylesheet left unversioned means a release can reach the
// iPad as new HTML and JS over the OLD CSS. This asserts every versioned asset
// matches; wire it into CI so a version bump that forgets one fails loudly
// instead of shipping a client that never updates.
const fs = require('fs');
const path = require('path');

const root = __dirname;
const version = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
).version;

const REQUIRED = [
  ['index.html', 'app.js'],
  ['index.html', 'style.css'],
  ['setup.html', 'style.css'],
];

let failed = false;
for (const [page, asset] of REQUIRED) {
  const html = fs.readFileSync(path.join(root, 'public', page), 'utf8');
  const re = new RegExp('/' + asset.replace('.', '\\.') + '(\\?v=([^"\']+))?["\']');
  const m = re.exec(html);
  if (!m) {
    console.error(`FAIL: public/${page} does not load /${asset}`);
    failed = true;
  } else if (!m[2]) {
    console.error(`FAIL: public/${page} loads /${asset} without a ?v= query`);
    failed = true;
  } else if (m[2] !== version) {
    console.error(
      `FAIL: public/${page} /${asset}?v=${m[2]} does not match package.json version ${version}`
    );
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`asset version OK: ${version} (${REQUIRED.length} assets)`);
