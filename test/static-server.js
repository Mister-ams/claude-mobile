// Minimal static server for the client harnesses (ipad-webkit.py,
// ipad-emulator.py, w2-ipad-verify.py, t04a). Serves public/ with the SAME
// headers the real server sends, so a CSP regression fails here rather than
// on the iPad. Deliberately separate from server.js: the harness must not
// need a PTY, WSL, dtach or auth to exercise the client.
//
// CSP PARITY (D10): PRODUCTION_CSP below is a verbatim copy of the policy in
// server.js (the `Content-Security-Policy` middleware above
// express.static). Any CSP change lands in BOTH files in the same commit.
// There is no required difference: the static tier never opens a WebSocket
// (the harness stubs `ws`), so connect-src 'self' is enough here too.
//
// argv[4] used to be 'tight' (drop 'unsafe-inline'). Production has been
// tight since T04, so the flag is now accepted and ignored -- every caller
// gets the production policy.
//
// The one endpoint answered here is GET /api/auth/status, because the client
// calls it on load and the auth screen renders from its answer. The fixture
// is shaped exactly like server.js's reply for a TOTP-only install (the
// operator's live configuration). Every other /api/* path 404s -- and in
// WebKit a 404 is a console error, so an unexpected API call fails the
// harness instead of passing unseen.
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], port = +process.argv[3];

const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const AUTH_STATUS = {
  hasPasskey: false,
  hasTotp: true,
  setupDone: true,
  serverFingerprint: null,
};

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml',
};

function productionHeaders(res) {
  res.setHeader('Content-Security-Policy', PRODUCTION_CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

const srv = http.createServer((req, res) => {
  productionHeaders(res);
  const u = req.url.split('?')[0];
  if (u === '/api/auth/status' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(AUTH_STATUS));
  }
  const f = path.join(root, u === '/' ? 'index.html' : u);
  // Never serve outside root (a harness is still a listening socket).
  if (!path.resolve(f).startsWith(path.resolve(root))) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
    res.end(d);
  });
});
// Die loudly on EADDRINUSE. Several worktrees run harnesses on this box at
// once; a silent bind failure leaves the harness probing a port that answers
// -- with ANOTHER checkout's files -- and every assertion then describes the
// wrong tree. Cost one debugging round on T04a.
srv.on('error', e => { console.error('LISTEN FAILED: ' + e.code); process.exit(1); });
srv.listen(port, '127.0.0.1', () => console.error('ready'));
