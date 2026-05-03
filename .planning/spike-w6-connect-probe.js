#!/usr/bin/env node
// W6 connect-message probe.
//
// Hypothesis: index.html:735 sends a `connect` message without a `renderer`
// field on the post-auth reconnect path. Server defaults gridRenderer=false
// and replies with `scrollback`, which a grid client's message handler
// silently drops. This probe authenticates against a running server and
// fires two `connect` payloads on separate WS connections to characterise
// the asymmetry server-side, without touching production code.
//
// Probe A: { type: 'connect', session: <id> }                     (bare)
// Probe B: { type: 'connect', session: <id>, renderer: 'grid' }
//
// Expected (bug present): A -> 'scrollback', B -> 'snapshot'.
//
// Usage:
//   node .planning/spike-w6-connect-probe.js [--port 3456] [--session <id>]
//
// Reads .totp-secret from this directory's parent (the repo root) to mint
// a TOTP for first-time auth. Issues a session token; doesn't persist it.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const { TOTP, Secret } = require(path.join(__dirname, '..', 'node_modules', 'otpauth'));

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const PORT = parseInt(argVal('--port', '3456'), 10);
const TARGET_SESSION = argVal('--session', null); // null -> auto-pick first

// ── totp ────────────────────────────────────────────────────────────────
const TOTP_PATH = path.join(__dirname, '..', '.totp-secret');
const totpSecret = JSON.parse(fs.readFileSync(TOTP_PATH, 'utf8')).secret;
function currentTotp() {
  return new TOTP({ secret: Secret.fromBase32(totpSecret), digits: 6, period: 30 }).generate();
}

// ── crypto: mirror server.js E2E ────────────────────────────────────────
function hexToBuf(h) { return Buffer.from(h, 'hex'); }

function makeSession(serverEphHex, saltHex) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const clientPubRaw = ecdh.getPublicKey(); // uncompressed point, 65 bytes
  const sharedSecret = ecdh.computeSecret(hexToBuf(serverEphHex));
  const info = Buffer.concat([
    Buffer.from('cm-e2e'),
    clientPubRaw,
    hexToBuf(serverEphHex),
  ]);
  const key = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, hexToBuf(saltHex), info, 32));
  return { key, clientPubHex: clientPubRaw.toString('hex'), sendSeq: 0, recvSeq: 0 };
}

function encrypt(state, obj) {
  state.sendSeq++;
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(state.sendSeq), 4);
  const aad = Buffer.alloc(8);
  aad.writeBigUInt64BE(BigInt(state.sendSeq));
  const cipher = crypto.createCipheriv('aes-256-gcm', state.key, iv);
  cipher.setAAD(aad);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, ct, tag]).toString('base64url');
  return JSON.stringify({ e: payload, n: state.sendSeq });
}

function decrypt(state, frameStr) {
  const parsed = JSON.parse(frameStr);
  if (parsed.type === 'key-exchange') return parsed;
  if (!parsed.e) return parsed;
  if (parsed.n !== state.recvSeq + 1) {
    throw new Error(`seq violation: expected ${state.recvSeq + 1}, got ${parsed.n}`);
  }
  const data = Buffer.from(parsed.e, 'base64url');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(12, data.length - 16);
  const aad = Buffer.alloc(8);
  aad.writeBigUInt64BE(BigInt(parsed.n));
  const decipher = crypto.createDecipheriv('aes-256-gcm', state.key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  state.recvSeq = parsed.n;
  return JSON.parse(pt.toString('utf8'));
}

// ── one full handshake + auth, returns { ws, state, sessions, sessionToken } ─
function openAuthenticated(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    let state = null;
    let sessionToken = null;
    let sessions = null;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error(`[${label}] auth timeout`));
      try { ws.close(); } catch (_) {}
    }, 8000);

    ws.on('error', (e) => { if (!resolved) reject(e); });

    const onMessage = (raw) => {
      try {
        const msg = state ? decrypt(state, raw.toString()) : JSON.parse(raw.toString());

        if (msg.type === 'key-exchange' && msg.ephemeral) {
          // Server's first message: ephemeral pubkey + salt. Build session.
          state = makeSession(msg.ephemeral, msg.salt);
          ws.send(JSON.stringify({ type: 'key-exchange', ephemeral: state.clientPubHex }));
          return;
        }

        if (msg.type === 'encrypted' && msg.status === 'ok') {
          // E2E established. Send TOTP auth.
          ws.send(encrypt(state, { type: 'auth', totp: currentTotp() }));
          return;
        }

        if (msg.type === 'auth') {
          if (msg.success) {
            sessionToken = msg.sessionToken;
            console.log(`[${label}] auth ok`);
          } else {
            ws.off('message', onMessage);
            clearTimeout(timeout);
            reject(new Error(`[${label}] auth failed: ${JSON.stringify(msg)}`));
          }
          return;
        }

        if (msg.type === 'sessions') {
          sessions = msg.sessions;
          if (!resolved) {
            resolved = true;
            // Detach so the caller can install a fresh listener without
            // racing this handler on the seq counter.
            ws.off('message', onMessage);
            clearTimeout(timeout);
            resolve({ ws, state, sessions, sessionToken });
          }
        }
      } catch (e) {
        if (!resolved) {
          ws.off('message', onMessage);
          clearTimeout(timeout);
          reject(e);
        }
      }
    };
    ws.on('message', onMessage);
  });
}

function readReplies(ws, state, durationMs) {
  return new Promise((resolve) => {
    const replies = [];
    const onMsg = (raw) => {
      try {
        const msg = decrypt(state, raw.toString());
        replies.push(msg);
      } catch (e) {
        replies.push({ type: '<decrypt-error>', error: e.message });
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve(replies);
    }, durationMs);
  });
}

function summarise(reply) {
  const t = reply.type || '<no-type>';
  if (t === 'snapshot') {
    return `snapshot (cols=${reply.cols} rows=${reply.rows} viewport=${reply.viewport?.length ?? '?'} rows scrollback=${reply.scrollback?.length ?? '?'} rows seq=${reply.seq} altScreen=${reply.altScreen})`;
  }
  if (t === 'scrollback') {
    return `scrollback (${reply.data?.length ?? '?'} bytes for session=${reply.session})`;
  }
  if (t === 'commands') {
    return `commands (count=${reply.commands?.length ?? '?'})`;
  }
  if (t === 'attention') {
    return `attention (session=${reply.session} reason=${reply.reason})`;
  }
  return t;
}

// ── main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[probe] connecting to ws://localhost:${PORT}`);
  const handshake = await openAuthenticated('setup');
  const sessions = handshake.sessions;
  console.log(`[probe] sessions reported: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`         id=${s.id} name=${JSON.stringify(s.name)} clients=${s.clients ?? '?'} dir=${s.dir ?? '?'}`);
  }
  if (sessions.length === 0) {
    console.log('[probe] no sessions on server -- nothing to connect to. Create one in the browser, then re-run.');
    handshake.ws.close();
    process.exit(2);
  }
  const targetId = TARGET_SESSION ? parseInt(TARGET_SESSION, 10) : sessions[0].id;
  console.log(`[probe] target session: ${targetId}`);
  handshake.ws.close();

  // Probe A: bare connect (no renderer)
  console.log('');
  console.log('[probe-A] bare connect (no renderer field)');
  const a = await openAuthenticated('A');
  a.ws.send(encrypt(a.state, { type: 'connect', session: targetId }));
  const aReplies = await readReplies(a.ws, a.state, 1500);
  for (const r of aReplies) console.log(`[probe-A]   reply: ${summarise(r)}`);
  if (aReplies.length === 0) console.log('[probe-A]   reply: <none>');
  a.ws.close();

  // Probe B: connect with renderer:'grid'
  console.log('');
  console.log('[probe-B] connect with renderer:"grid"');
  const b = await openAuthenticated('B');
  b.ws.send(encrypt(b.state, { type: 'connect', session: targetId, renderer: 'grid' }));
  const bReplies = await readReplies(b.ws, b.state, 1500);
  for (const r of bReplies) console.log(`[probe-B]   reply: ${summarise(r)}`);
  if (bReplies.length === 0) console.log('[probe-B]   reply: <none>');
  b.ws.close();

  // Verdict
  console.log('');
  const aTypes = aReplies.map(r => r.type);
  const bTypes = bReplies.map(r => r.type);
  const aHasScrollback = aTypes.includes('scrollback');
  const aHasSnapshot = aTypes.includes('snapshot');
  const bHasSnapshot = bTypes.includes('snapshot');
  const bHasScrollback = bTypes.includes('scrollback');

  console.log('[verdict]');
  console.log(`  A (bare):            scrollback=${aHasScrollback}  snapshot=${aHasSnapshot}`);
  console.log(`  B (renderer:grid):   scrollback=${bHasScrollback}  snapshot=${bHasSnapshot}`);
  if (aHasScrollback && !aHasSnapshot && bHasSnapshot && !bHasScrollback) {
    console.log('  -> BUG CONFIRMED: server treats renderer-less connect as legacy client.');
    console.log('     Grid client receives "scrollback" payload, which its handler drops.');
    process.exit(0);
  }
  if (aHasSnapshot) {
    console.log('  -> bare connect already returns snapshot. Bug not present (or fix already in place).');
    process.exit(0);
  }
  console.log('  -> inconclusive. See replies above.');
  process.exit(1);
})().catch((e) => {
  console.error('[probe] fatal:', e.message);
  process.exit(1);
});
