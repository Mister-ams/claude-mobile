---
project: claude-mobile
type: requirements
status: draft
created: 2026-03-17
feature: security-hardening
---

# Requirements: Security Hardening P0-P2

## Problem Statement

Claude Mobile tunnels terminal sessions through ngrok, which terminates TLS at its
edge and can observe all traffic in plaintext. Session tokens are transmitted as
JSON over WebSocket without end-to-end encryption. The stored IP field on session
tokens is never enforced, allowing token replay from any network. No mechanism
exists to detect a rogue proxy substituting for the legitimate ngrok endpoint.

## Success Criteria

- [ ] Session tokens are IP-bound: a token issued to IP A is rejected when presented from IP B
- [ ] All WebSocket frames after key exchange are encrypted end-to-end (ngrok sees only ciphertext)
- [ ] Server's public key is pinned on first use (TOFU); connection is rejected if key changes unexpectedly
- [ ] Existing TOTP and WebAuthn auth flows continue to work without modification
- [ ] No new npm dependencies required (Node.js crypto stdlib only)

## Scope

### In scope

- P0: Enforce IP binding on `validateSessionToken()` -- reject tokens from non-matching IPs
- P1: Ephemeral ECDH key agreement at WebSocket connection time; AES-256-GCM encryption
  of all subsequent messages; key derivation per-session (perfect forward secrecy)
- P2: Server generates a persistent ECDH identity key; client pins it on first successful
  auth (TOFU); warns and blocks if key changes on subsequent connections
- Client-side key storage in localStorage (fingerprint of server public key)
- Graceful handling: IP change during token lifetime triggers re-auth (not crash)

### Out of scope

- Full onion routing (Tor-style multi-hop) -- latency incompatible with terminal use
- Certificate transparency or CA-based pinning -- ngrok controls the cert
- Hardware security module (HSM) for server key storage
- Multi-device key synchronization (single phone is the expected client)

## Integration Context

| Component | Relationship |
|-----------|-------------|
| server.js | Add IP validation in validateSessionToken(), ECDH key exchange handler, AES-256-GCM encrypt/decrypt wrapper, persistent identity key generation + storage |
| public/index.html | Add client-side ECDH key agreement, message encryption/decryption, TOFU key pinning with localStorage, key-change warning UI |
| .server-identity-key | New gitignored file storing the server's persistent ECDH public+private key |

## Constraints

- **Stack**: Node.js crypto module only (ECDH, AES-256-GCM, HKDF all available)
- **Auth**: existing TOTP + WebAuthn must work unchanged; encryption layer sits below auth
- **Dependencies**: zero new npm packages
- **Must not break**: scrollback redaction, attention detection, image upload, token rotation

## Simplest Viable Version

P0 is a 5-line change (enforce the already-stored IP). P1 wraps all WebSocket
`ws.send()` and `ws.on('message')` calls in encrypt/decrypt using a shared
secret derived from ephemeral ECDH. P2 adds a persistent server key whose
fingerprint the client stores in localStorage. All three tiers modify only
server.js and index.html -- no architectural changes, no new files beyond the
identity key.

## Open Questions

- Should IP binding use exact match or subnet match (e.g. /24)? Exact is safer
  but mobile networks may rotate IPs mid-session via carrier NAT.
- Should the TOFU key-change warning allow override (re-pin) or hard-block?
  SSH uses interactive override; for mobile, a hard block with "re-setup required"
  may be more appropriate.
