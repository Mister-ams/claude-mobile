---
project: claude-mobile
type: spec
status: draft
created: 2026-03-17
updated: 2026-03-17
source: .planning/requirements-security-hardening.md
---

# Technical Design: Security Hardening P0-P2

## Overview

Implements three-tier transport security for Claude Mobile, eliminating ngrok as a
cleartext observer. P0 enforces IP binding on session tokens (5-line change). P1 adds
ephemeral ECDH key agreement + AES-256-GCM encryption on all WebSocket frames. P2
adds a persistent server identity key with TOFU pinning on the client.

## Current State

- `server.js:77` -- `sessionTokens` Map stores `{ expires, ip }` but `validateSessionToken()` (line 85) never checks the `ip` field
- `server.js:683-865` -- WebSocket message handler sends/receives plaintext JSON
- `server.js:592-603` -- `broadcastSessions()` and `broadcastAttention()` call `ws.send()` directly
- `server.js:629-631` -- pty output broadcast calls `ws.send()` directly
- `public/index.html:797-818` -- `ws.onmessage` parses raw JSON; `ws.send()` sends plaintext
- No server identity key exists; no client-side key storage
- All `ws.send()` calls in server.js: ~12 call sites (auth responses, sessions broadcast, output, scrollback, attention, error, warning, expired, refreshed)
- Client `ws.send()` calls: ~5 sites (auth, connect, create, input, resize, rename, close, refresh)

## Target State

### System Design

```
Phone                        ngrok                       Laptop
  |                            |                           |
  |-- wss:// TLS (ngrok) ---->|                           |
  |                            |-- ws:// plaintext ------>|
  |                            |                           |
  |  1. WS connect            |                           |
  |  2. Server sends identity pubkey + ephemeral pubkey   |
  |  3. Client checks TOFU pin (P2)                       |
  |  4. Client sends ephemeral pubkey                     |
  |  5. Both derive shared secret via ECDH                |
  |  6. All subsequent frames: AES-256-GCM(JSON)          |
  |                            |                           |
  |  ngrok sees: encrypted     |  server decrypts locally |
  |  blobs only                |                           |
```

### Crypto Primitives (all from Node.js `crypto` / Web Crypto API)

| Operation | Server (Node.js) | Client (browser) |
|-----------|-----------------|------------------|
| ECDH key pair | `crypto.createECDH('prime256v1')` | `crypto.subtle.generateKey('ECDH', P-256)` |
| Shared secret | `ecdh.computeSecret(peerPub)` | `crypto.subtle.deriveBits()` |
| Key derivation | `crypto.hkdfSync('sha256', secret, salt, info, 32)` | `crypto.subtle.deriveBits()` via HKDF |
| Encryption | `crypto.createCipheriv('aes-256-gcm', key, iv)` | `crypto.subtle.encrypt('AES-GCM')` |
| Signing | `crypto.sign('sha256', ephPub, identityPrivKey)` | `crypto.subtle.verify('ECDSA', P-256, SHA-256)` |
| Fingerprint | `crypto.createHash('sha256').update(pubkey).digest('hex')` | `crypto.subtle.digest('SHA-256')` |

### Protocol Flow

1. Server generates persistent identity key on first run, saves to `.server-identity-key`
2. On WebSocket connect, server generates ephemeral ECDH keypair
3. Server sends: `{ type: 'key-exchange', identity: <hex>, ephemeral: <hex>, sig: <hex> }`
   - `sig` = ECDSA-P256-SHA256 signature of the ephemeral pubkey bytes, signed by identity private key
   - Without this signature, an attacker could replay the static identity pubkey with their own ephemeral (red-team finding #1)
4. Client verifies `sig` against `identity` pubkey. If invalid, close connection.
5. Client checks identity fingerprint against localStorage `cm-server-fp`:
   - First connection: show fingerprint, require tap-to-confirm before pinning (TOFU)
   - Match: proceed silently
   - Mismatch: show warning with old/new fingerprints, require explicit re-pin
   - OOB verification: /setup page displays server fingerprint for visual confirmation
6. Client generates ephemeral ECDH keypair
7. Client sends: `{ type: 'key-exchange', ephemeral: <hex> }`
8. Both derive shared secret: `HKDF(ECDH(eph_a, eph_b), salt=random_32, info='cm-e2e'||cpub||spub)`
9. Server enforces: no non-key-exchange messages accepted until handshake complete (anti-downgrade)
10. All subsequent messages: `{ e: <base64(iv + ciphertext + tag)>, n: <seq> }`

### Message Envelope (post-handshake)

Encrypted: `AES-256-GCM(key, iv=counter_12_bytes, aad=seq_number, plaintext=JSON.stringify(msg))`
Wire format: `{ e: base64url(iv[12] || ciphertext || tag[16]), n: <monotonic_seq> }`
Decryption: verify seq > last_seen, split iv/ciphertext/tag, decrypt with seq as AAD
Counter-based IV: 4-byte zero prefix + 8-byte big-endian counter (eliminates birthday collision)

## Key Decisions

| # | Decision | Chosen | Status | Rationale |
|---|----------|--------|--------|-----------|
| 1 | IP binding match type | Exact match | locked | Mobile NAT IP rotation triggers re-auth via token expiry (30-min TTL). Subnet matching introduces false-positive risk. Token rotation handles the graceful path. |
| 2 | TOFU key-change behavior | Override with re-pin | locked | SSH model -- show warning with old/new fingerprints, user confirms to re-pin. Hard-block would brick access if server key is legitimately regenerated. |
| 3 | ECDH curve | P-256 (prime256v1) | locked | Available in both Node.js crypto and Web Crypto API. X25519 not available in Web Crypto on all Safari versions. |
| 4 | Key exchange timing | Before auth | locked | Encryption must wrap auth messages too -- TOTP codes and session tokens must not be visible to ngrok. |
| 5 | Identity key storage | `.server-identity-key` (gitignored) | locked | Same pattern as `.totp-secret` and `.credentials.json`. Auto-generated on first run. |
| 6 | HTTP API encryption | Not encrypted (P1 scope) | discretion | HTTP endpoints (/api/config, /api/upload, /api/passkey/*) still use TLS-only via ngrok. E2E encryption is WebSocket-only. HTTP /api/auth/refresh deprecated (WS refresh path preferred). |
| 7 | Ephemeral key authentication | ECDSA signature by identity key | locked | Red-team critical: without signing, attacker replays identity pubkey with own ephemeral. Signature cryptographically binds identity to ephemeral. |
| 8 | First-connection verification | OOB via /setup page | locked | Red-team critical: TOFU bootstrap through compromised tunnel pins attacker's key. /setup (localhost-only) displays fingerprint for visual confirmation. |
| 9 | Anti-downgrade | Mandatory encryption | locked | Server rejects any non-key-exchange message until handshake complete. No plaintext fallback. |
| 10 | Nonce strategy | Counter-based (not random) | locked | Eliminates birthday collision risk. 8-byte counter = 2^64 messages per session. Sequence number as AAD provides replay protection. |
| 11 | IP extraction through ngrok | X-Forwarded-For header | locked | ws._socket._peername returns ngrok peer IP. Must extract from WS upgrade request X-Forwarded-For header. Defense-in-depth, not strong guarantee. |

## Integration Risks

- **Safari Web Crypto async**: all Web Crypto operations are async (Promises). Client `secureSend()` must use a promise queue to serialize encryption + send. Server-side Node.js crypto is synchronous, so no queue needed there.
- **Key exchange MITM**: mitigated by ECDSA signature on ephemeral key (Decision #7) + TOFU fingerprint pinning + OOB verification via /setup (Decision #8). First connection through compromised tunnel is protected by requiring user to visually confirm fingerprint shown at /setup.
- **Scrollback size**: 100KB scrollback encrypted per-chunk may cause visible latency on reconnect. Mitigation: encrypt in 16KB chunks.
- **IP binding through ngrok**: X-Forwarded-For is the best available signal but can be spoofed by tunnel operator. IP binding is defense-in-depth, not a primary security boundary.
- **HTTP endpoint exposure**: /api/auth/refresh deprecated (WS path preferred). /api/upload and /api/passkey/* remain TLS-only -- accepted risk documented.

## Verification Strategy

- [ ] Token issued to IP A returns `false` from `validateSessionToken()` when checked from IP B
- [ ] After key exchange, `ws.send()` output is opaque base64 (not readable JSON) when inspected at ngrok layer
- [ ] TOFU: first connection stores fingerprint; second connection with same server succeeds silently
- [ ] TOFU: connection with changed server key shows warning UI before allowing re-pin
- [ ] Existing TOTP login flow works end-to-end through encrypted channel
- [ ] Existing WebAuthn passkey flow works (HTTP-based, not affected)
- [ ] Token rotation works through encrypted channel
- [ ] Image upload works (HTTP-based, not affected)

## Affected Files

| File | Action | Change Description |
|------|--------|--------------------|
| server.js | modify | P0: add IP check in `validateSessionToken()`. P1: add identity key load/generate, ECDH key exchange handler, `secureSend()` wrapper, decrypt incoming messages. P2: serve identity public key in key-exchange message. |
| public/index.html | modify | P1: add Web Crypto ECDH key exchange, `secureSend()`/`secureReceive()` wrappers around all ws.send/onmessage. P2: TOFU fingerprint check + warning UI + localStorage pin. |
| .server-identity-key | create | Persistent ECDH identity key (JSON: { publicKey, privateKey, created }). Auto-generated on first run. |
| .gitignore | modify | Add `.server-identity-key` |

## Implementation Sequence

1. **P0: IP binding** (server.js only)
   - Dependencies: none
   - Deliverable: `validateSessionToken()` checks `entry.ip` against caller IP; returns false on mismatch with audit log entry

2. **P1: Server-side encryption** (server.js)
   - Dependencies: P0
   - Deliverable: identity key generation, ECDH key exchange handler, `secureSend()` wrapper replacing all `ws.send()` calls, decrypt layer on `ws.on('message')`

3. **P1: Client-side encryption** (index.html)
   - Dependencies: P1 server
   - Deliverable: Web Crypto ECDH key exchange on connect, `secureSend()`/`secureReceive()` wrappers, all existing `ws.send()` and `handle()` calls routed through encryption layer

4. **P2: TOFU key pinning** (both files)
   - Dependencies: P1
   - Deliverable: server includes identity pubkey in key-exchange; client stores fingerprint in localStorage, checks on reconnect, shows warning UI on mismatch with re-pin option

5. **Verification** (manual)
   - Dependencies: P2
   - Deliverable: test all 8 verification criteria above
