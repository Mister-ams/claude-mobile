---
project: claude-mobile
type: plan
status: draft
created: 2026-03-17
updated: 2026-03-17
source: .planning/tech-design-security-hardening.md
---

# Execution Plan: Security Hardening P0-P2

## Domain Summary

| Domain | Tasks | Executor |
|--------|-------|----------|
| api (server.js) | 6 | /dt.execute-api |
| frontend (index.html) | 4 | /dt.execute-ui |
| config (.gitignore) | 1 | /dt.execute-api |
| **Total** | **11** | |

## Wave Structure

| Wave | Tasks | Theme | Effort |
|------|-------|-------|--------|
| 0 | T01, T02 | Foundation: IP binding + identity key | small |
| 1 | T03, T04 | Server-side encryption core | large |
| 2 | T05, T06 | Client-side encryption + key exchange | large |
| 3 | T07, T08, T09 | TOFU pinning (server + client + setup OOB) | medium |
| 4 | T10, T11 | Anti-downgrade + verification | medium |

---

## Wave 0: Foundation

### T01: IP binding on session tokens [P0]

**Domain**: api
**Action**: modify
**Files**: server.js
**Depends on**: none
**Risk**: medium (15+ call sites for validateSessionToken)
**Effort**: medium

Change `validateSessionToken(token)` to `validateSessionToken(token, callerIP)`.
Add IP check: `if (entry.ip && callerIP && entry.ip !== callerIP) return false`.
Audit log on mismatch: `audit('SECURITY', 'Token IP mismatch', callerIP)`.

Update all call sites (~15):
- WS handler: pass `ws._ip` (but see T02 for X-Forwarded-For fix)
- HTTP routes: pass `req.ip`
- Periodic expiry checker: pass `ws._ip`
- `getClientIP()`: update to check `ws._req?.headers['x-forwarded-for']` first
  (from WS upgrade request), falling back to `ws._socket._peername.address`

**Verification**: Issue token from IP A, call `validateSessionToken(token, 'different-ip')` -- returns false. Audit log shows "Token IP mismatch".

### T02: Server identity key generation + .gitignore

**Domain**: api
**Action**: modify + create
**Files**: server.js, .gitignore
**Depends on**: none
**Risk**: low
**Effort**: small
**Parallel**: yes (with T01)

Add `.server-identity-key` to .gitignore.

Add identity key management to server.js:
- `IDENTITY_KEY_PATH = path.join(__dirname, '.server-identity-key')`
- `loadOrCreateIdentityKey()`: if file exists, load { publicKey, privateKey }.
  If not, generate P-256 EC keypair via `crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })`, save as JSON { publicKey (hex), privateKey (PEM), fingerprint (SHA-256 hex of pubkey), created }.
- Call at startup after `loadTotpSecret()`.
- Log fingerprint at startup: `console.log('  Identity: ' + fingerprint.slice(0,16) + '...')`.

**Verification**: Server starts, creates `.server-identity-key`, logs fingerprint. File is gitignored.

---

## Wave 1: Server-side Encryption

### T03: Server ECDH key exchange handler + ECDSA signing

**Domain**: api
**Action**: modify
**Files**: server.js
**Depends on**: T02
**Risk**: high (crypto protocol, must be correct)
**Effort**: large

In `wss.on('connection')`, after ws setup:
1. Generate ephemeral ECDH: `crypto.createECDH('prime256v1')`, `eph.generateKeys()`.
2. Sign ephemeral pubkey with identity private key: `crypto.sign('sha256', ephPubBuf, identityPrivateKey)`.
3. Send key-exchange (plaintext -- only message allowed before encryption):
   `ws.send(JSON.stringify({ type: 'key-exchange', identity: identityPubHex, ephemeral: ephPubHex, sig: sigHex, salt: randomSalt32Hex }))`.
4. Store ephemeral on ws object: `ws._eph = eph`, `ws._salt = salt`.
5. Add `ws.encrypted = false`, `ws._sendSeq = 0`, `ws._recvSeq = 0`.

Handle incoming `key-exchange` response from client:
1. `ws._eph.computeSecret(clientEphPubBuf)` -> raw shared secret.
2. Derive key: `crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.concat([Buffer.from('cm-e2e'), clientPub, serverPub]), 32)`.
3. Store: `ws._sessionKey = derivedKey`, `ws.encrypted = true`.
4. Delete ephemeral: `delete ws._eph`.
5. Audit: `audit('CRYPTO', 'E2E session established', ws._ip)`.

**Verification**: After key exchange, `ws.encrypted === true` and `ws._sessionKey` is 32 bytes.

### T04: Server secureSend() + decrypt layer

**Domain**: api
**Action**: modify
**Files**: server.js
**Depends on**: T03
**Risk**: high (all 12 ws.send call sites must be wrapped)
**Effort**: large

Create `secureSend(ws, msg)`:
- If `!ws.encrypted`: send plaintext JSON (only for key-exchange messages).
- If `ws.encrypted`: increment `ws._sendSeq`, build counter-IV (4-byte zero + 8-byte BE seq), encrypt with AES-256-GCM (key=`ws._sessionKey`, iv=counterIV, aad=seqBuffer), send `{ e: base64url(iv+ciphertext+tag), n: ws._sendSeq }`.

Create `secureReceive(ws, rawData)`:
- Parse JSON. If `rawData.e` exists: verify `rawData.n > ws._recvSeq`, decrypt AES-256-GCM with counter-IV from n, update `ws._recvSeq = rawData.n`, return parsed plaintext JSON.
- If no `.e` field and `ws.encrypted`: reject (anti-downgrade).
- If no `.e` field and `!ws.encrypted`: return parsed JSON (key-exchange phase only).

Replace all `ws.send(JSON.stringify(...))` call sites (~12) with `secureSend(ws, obj)`.
Replace `ws.on('message')` JSON.parse with `secureReceive()`.

Update `broadcastSessions()` and `broadcastAttention()` to use `secureSend()`.
Update pty output broadcast to use `secureSend()`.

**Verification**: After handshake, all WS frames on the wire are `{ e: ..., n: ... }` format. Plaintext JSON rejected post-handshake.

---

## Wave 2: Client-side Encryption

### T05: Client Web Crypto ECDH + key exchange

**Domain**: frontend
**Action**: modify
**Files**: public/index.html
**Depends on**: T03
**Risk**: high (Web Crypto is async, Safari compatibility)
**Effort**: large

Add crypto functions to the main script block:

`async function performKeyExchange(serverMsg)`:
1. Verify ECDSA signature: import server identity pubkey as ECDSA P-256, `crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}, identityKey, sig, ephPubBytes)`. If false, close WS.
2. Generate client ephemeral ECDH P-256 keypair via `crypto.subtle.generateKey()`.
3. Derive shared secret: `crypto.subtle.deriveBits({name:'ECDH',public:serverEphKey}, clientPrivKey, 256)`.
4. Derive session key via HKDF: `crypto.subtle.importKey('raw', sharedSecret, 'HKDF')` then `crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:saltBytes,info:concat('cm-e2e',clientPub,serverPub)}, hkdfKey, 256)`.
5. Store: `window._sessionKey`, `window._sendSeq = 0`, `window._recvSeq = 0`, `window._encrypted = true`.
6. Send client ephemeral pubkey: `ws.send(JSON.stringify({type:'key-exchange',ephemeral:clientPubHex}))`.

Wire into `ws.onopen`: wait for first message (key-exchange from server), call `performKeyExchange()`.

**Verification**: Client completes key exchange, `window._encrypted === true`.

### T06: Client secureSend() + secureReceive() wrappers

**Domain**: frontend
**Action**: modify
**Files**: public/index.html
**Depends on**: T05
**Risk**: high (must serialize async encryption)
**Effort**: large

`async function secureSend(obj)`:
- If `!window._encrypted`: `ws.send(JSON.stringify(obj))` (key-exchange only).
- If encrypted: increment `_sendSeq`, build counter-IV (4-byte zero + 8-byte BE seq), encrypt via `crypto.subtle.encrypt({name:'AES-GCM',iv:counterIV,additionalData:seqBuf}, sessionKey, plaintext)`, send `{ e: base64url(iv+ciphertext+tag), n: _sendSeq }`.

Implement send queue (promise chain) to serialize `secureSend()` calls:
```
let sendQueue = Promise.resolve();
function queueSend(obj) { sendQueue = sendQueue.then(() => secureSend(obj)); }
```

`async function secureReceive(rawData)`:
- Parse JSON. If `.e` exists: verify `.n > _recvSeq`, decrypt, update `_recvSeq`, return parsed plaintext.
- If no `.e` and encrypted: ignore (anti-downgrade).

Replace all existing `ws.send(JSON.stringify(...))` calls (~8) with `queueSend(obj)`.
Update `ws.onmessage` to route through `secureReceive()` then existing `handle()`.

**Verification**: All client WS sends are encrypted. Messages arrive in order via queue.

---

## Wave 3: TOFU Key Pinning [P2]

### T07: Server identity pubkey in key-exchange + /setup fingerprint

**Domain**: api
**Action**: modify
**Files**: server.js
**Depends on**: T03
**Risk**: low
**Effort**: small

Already done in T03 (identity pubkey included in key-exchange message).
This task adds the OOB verification channel:

Add server identity fingerprint to the `/setup` page HTML:
- After "Setup complete" message, display: `Server fingerprint: {fingerprint}`.
- Add to `/api/auth/status` response: `serverFingerprint: identityFingerprint` (only when setup is complete).
- Log fingerprint at server startup in the banner.

**Verification**: /setup page shows fingerprint. `/api/auth/status` includes `serverFingerprint`.

### T08: Client TOFU fingerprint pinning + warning UI

**Domain**: frontend
**Action**: modify
**Files**: public/index.html
**Depends on**: T05, T07
**Risk**: medium
**Effort**: medium

In `performKeyExchange()`, after signature verification:
1. Compute fingerprint: `SHA-256(identityPubBytes)` -> hex string.
2. Check `localStorage.getItem('cm-server-fp')`:
   - **null** (first connection): show confirmation dialog with fingerprint.
     "First connection. Server fingerprint: ABCD...1234. Verify this matches
     your laptop's /setup page. [Confirm & Pin] [Cancel]". On confirm:
     `localStorage.setItem('cm-server-fp', fingerprint)`. On cancel: close WS.
   - **match**: proceed silently.
   - **mismatch**: show warning. "SERVER KEY CHANGED. Old: XXXX New: YYYY.
     This could indicate a man-in-the-middle attack. [Re-pin (accept new key)]
     [Disconnect]". On re-pin: update localStorage. On disconnect: close WS.
3. Both dialogs are HTML overlays (not `confirm()`/`alert()`) styled with Blueprint theme.

**Verification**: First connection shows pin dialog. Same server reconnects silently. Changed key shows warning.

### T09: Deprecate HTTP /api/auth/refresh

**Domain**: api
**Action**: modify
**Files**: server.js
**Depends on**: T04
**Risk**: low
**Effort**: small

Remove or deprecate the HTTP `/api/auth/refresh` endpoint (server.js:453-465).
The WS refresh path (`msg.type === 'refresh'`, server.js:748-757) is already
encrypted post-P1 and is the preferred path. Client already uses WS refresh.

Option: keep the endpoint but return `410 Gone` with message
"Use WebSocket refresh" to surface the deprecation clearly.

**Verification**: HTTP POST to /api/auth/refresh returns 410. WS refresh still works.

---

## Wave 4: Anti-downgrade + Verification

### T10: Server anti-downgrade enforcement

**Domain**: api
**Action**: modify
**Files**: server.js
**Depends on**: T04
**Risk**: medium
**Effort**: small

In the WS message handler, before processing any message type:
- If `!ws.encrypted && msg.type !== 'key-exchange'`: reject with
  `secureSend(ws, { type: 'error', message: 'Encryption required' })` and close.
- Add 5-second timeout after connection: if `!ws.encrypted` after 5s, close WS.

**Verification**: Connect WS, send plaintext auth message without key exchange -- connection closed. Connect and wait 6s without key exchange -- connection closed.

### T11: End-to-end verification pass

**Domain**: test
**Action**: manual
**Files**: none (manual testing)
**Depends on**: T01-T10
**Risk**: low
**Effort**: medium

Verify all 8 TDD success criteria:
1. Token IP binding: token from IP A rejected from IP B
2. WS frames opaque: post-handshake frames are `{ e:..., n:... }`
3. TOFU first-pin: first connection shows fingerprint confirmation
4. TOFU key-change: changed key shows warning with re-pin option
5. TOTP login: works through encrypted channel
6. WebAuthn: works (HTTP-based, unaffected)
7. Token rotation: works through encrypted WS channel
8. Image upload: works (HTTP-based, unaffected)

**Verification**: All 8 criteria pass.

---

## Verification Matrix

| # | Success Criterion | Verified By | Check |
|---|-------------------|-------------|-------|
| V1 | IP-bound tokens | T01 | validateSessionToken(token, 'wrong-ip') === false |
| V2 | Encrypted WS frames | T04, T06 | Wire inspection shows only { e:, n: } post-handshake |
| V3 | TOFU first-pin | T08 | First connection shows fingerprint dialog |
| V4 | TOFU key-change warning | T08 | Delete .server-identity-key, restart, reconnect -- warning shown |
| V5 | TOTP works encrypted | T11 | Login with TOTP code through encrypted channel |
| V6 | WebAuthn unaffected | T11 | Passkey login works (HTTP path, no change) |
| V7 | Token rotation encrypted | T09, T11 | WS refresh path works, HTTP refresh returns 410 |
| V8 | Image upload unaffected | T11 | Upload image via HTTP -- works |
| V9 | No new dependencies | all | package.json unchanged |
| V10 | Anti-downgrade | T10 | Plaintext message post-connect rejected |
