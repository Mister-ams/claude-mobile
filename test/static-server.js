// Minimal static server for the W2 client verification harness. Serves
// public/ with the SAME Content-Security-Policy the real server sends
// (server.js:589) so a CSP regression fails here rather than on the iPad.
// Deliberately separate from server.js: the harness must not need a PTY,
// WSL, dtach or auth to exercise the client.
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], port = +process.argv[3];
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json',
};
http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const f = path.join(root, u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.setHeader('Content-Security-Policy', [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data: blob:",
      "font-src 'self'",
    ].join('; '));
    res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
    res.end(d);
  });
}).listen(port, '127.0.0.1', () => console.error('ready'));
