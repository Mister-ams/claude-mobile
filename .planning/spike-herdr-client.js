#!/usr/bin/env node
/**
 * spike-herdr-client.js -- minimal herdr socket client (Wave 1 / S1).
 *
 * Newline-delimited JSON over the unix socket. This is the throwaway
 * prototype of what W5/T27 would become as lib/herdr.js.
 *
 * MUST run INSIDE WSL -- the socket lives at /root/.config/herdr/herdr.sock
 * in the WSL2 VM's ext4 and is not reachable from Windows (see
 * spike-herdr-winbridge.js for that evidence).
 *
 * Usage:
 *   node spike-herdr-client.js <method> '<json-params>'
 *   node spike-herdr-client.js --raw   # dump raw bytes of a pane.read
 */
const net = require('net');

const SOCK = process.env.HERDR_SOCK || '/root/.config/herdr/herdr.sock';

function connect() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Send one request, resolve its matching response. */
function rpc(sock, method, params, id) {
  return new Promise((resolve, reject) => {
    const reqId = id || 'spike-' + Math.random().toString(36).slice(2, 10);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (msg.id === reqId) {
          sock.removeListener('data', onData);
          if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
          return resolve(msg.result);
        }
      }
    };
    sock.on('data', onData);
    // `params` is REQUIRED by the server even for no-arg methods like ping;
    // omitting it returns invalid_request AND closes the connection.
    const payload = { id: reqId, method, params: params === undefined ? {} : params };
    sock.write(JSON.stringify(payload) + '\n');
    setTimeout(() => {
      sock.removeListener('data', onData);
      reject(new Error('timeout waiting for ' + method));
    }, 20000);
  });
}

/**
 * One-shot call. The herdr API socket is ONE REQUEST PER CONNECTION -- the
 * server writes the response and immediately closes. Every RPC therefore
 * needs a fresh connect(). Long-lived connections exist only for
 * events.subscribe / events.wait.
 */
async function call(method, params) {
  const sock = await connect();
  try {
    return await rpc(sock, method, params);
  } finally {
    sock.end();
  }
}

async function main() {
  const method = process.argv[2];
  const params = process.argv[3] ? JSON.parse(process.argv[3]) : undefined;
  if (!method) {
    console.error("usage: spike-herdr-client.js <method> '<json-params>'");
    process.exit(2);
  }
  const res = await call(method, params);
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { connect, rpc, call, SOCK };

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR: ' + e.message);
    process.exit(1);
  });
}
