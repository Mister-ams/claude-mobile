#!/usr/bin/env node
// W6 input injector. Authenticates, connects to a session, and sends a
// single { type: 'input' } message before exiting. Used by the Playwright
// browser test as a side-channel for generating PTY output that observing
// browser tabs should (or shouldn't) render after a forced WS reconnect.
//
// Usage:
//   node .planning/spike-w6-input-inject.js --port 3457 --session 0 --text "echo HI\n"

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const { TOTP, Secret } = require(path.join(__dirname, '..', 'node_modules', 'otpauth'));

const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const PORT = parseInt(argVal('--port', '3456'), 10);
const SESSION = parseInt(argVal('--session', '0'), 10);
const TEXT = argVal('--text', null);
if (!TEXT) { console.error('--text required'); process.exit(2); }

const TOTP_PATH = path.join(__dirname, '..', '.totp-secret');
const totpSecret = JSON.parse(fs.readFileSync(TOTP_PATH, 'utf8')).secret;
function currentTotp() {
  return new TOTP({ secret: Secret.fromBase32(totpSecret), digits: 6, period: 30 }).generate();
}

function hexToBuf(h) { return Buffer.from(h, 'hex'); }
function makeSession(serverEphHex, saltHex) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const clientPubRaw = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(hexToBuf(serverEphHex));
  const info = Buffer.concat([Buffer.from('cm-e2e'), clientPubRaw, hexToBuf(serverEphHex)]);
  const key = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, hexToBuf(saltHex), info, 32));
  return { key, clientPubHex: clientPubRaw.toString('hex'), sendSeq: 0, recvSeq: 0 };
}
function encrypt(state, obj) {
  state.sendSeq++;
  const iv = Buffer.alloc(12); iv.writeBigUInt64BE(BigInt(state.sendSeq), 4);
  const aad = Buffer.alloc(8); aad.writeBigUInt64BE(BigInt(state.sendSeq));
  const cipher = crypto.createCipheriv('aes-256-gcm', state.key, iv);
  cipher.setAAD(aad);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return JSON.stringify({ e: Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url'), n: state.sendSeq });
}
function decrypt(state, frameStr) {
  const parsed = JSON.parse(frameStr);
  if (parsed.type === 'key-exchange') return parsed;
  if (!parsed.e) return parsed;
  if (parsed.n !== state.recvSeq + 1) throw new Error(`seq violation: ${parsed.n} vs ${state.recvSeq + 1}`);
  const data = Buffer.from(parsed.e, 'base64url');
  const aad = Buffer.alloc(8); aad.writeBigUInt64BE(BigInt(parsed.n));
  const decipher = crypto.createDecipheriv('aes-256-gcm', state.key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(data.length - 16));
  decipher.setAAD(aad);
  const pt = Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]);
  state.recvSeq = parsed.n;
  return JSON.parse(pt.toString('utf8'));
}

(async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  let state = null;
  let phase = 'kx';

  const timeout = setTimeout(() => { console.error('timeout'); process.exit(1); }, 8000);

  ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });

  ws.on('message', (raw) => {
    try {
      const msg = state ? decrypt(state, raw.toString()) : JSON.parse(raw.toString());
      if (msg.type === 'key-exchange' && msg.ephemeral) {
        state = makeSession(msg.ephemeral, msg.salt);
        ws.send(JSON.stringify({ type: 'key-exchange', ephemeral: state.clientPubHex }));
        return;
      }
      if (msg.type === 'encrypted' && msg.status === 'ok') {
        ws.send(encrypt(state, { type: 'auth', totp: currentTotp() }));
        phase = 'auth';
        return;
      }
      if (msg.type === 'auth') {
        if (!msg.success) { console.error('auth failed:', JSON.stringify(msg)); process.exit(1); }
        return;
      }
      if (msg.type === 'sessions' && phase === 'auth') {
        phase = 'connected';
        ws.send(encrypt(state, { type: 'connect', session: SESSION, renderer: 'grid' }));
        // Defer input slightly so the connect is processed first.
        setTimeout(() => {
          ws.send(encrypt(state, { type: 'input', data: TEXT }));
          // Wait a beat for the server to process, then exit clean.
          setTimeout(() => { clearTimeout(timeout); ws.close(); process.exit(0); }, 250);
        }, 100);
      }
    } catch (e) { console.error('handler:', e.message); process.exit(1); }
  });
})();
