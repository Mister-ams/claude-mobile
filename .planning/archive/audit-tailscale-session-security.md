---
project: claude-mobile
type: audit
status: active
created: 2026-03-18
updated: 2026-03-18
---

# Red Team Audit: Tailscale Migration + Session Persistence + Security

## Critical (resolved in TDD update)

1. HTTPS REQUIRED FOR WEBAUTHN [82/100] -- WebAuthn requires secure context
   (https:// or localhost). TDD showed plain HTTP over Tailscale MagicDNS
   hostname. Passkey registration and authentication would fail.
   Resolution: Decision #9 added. `tailscale serve` terminates TLS with
   auto-provisioned Let's Encrypt certs, proxies HTTPS:443 -> localhost:3456.

## Warning (addressed in TDD update)

2. Inactivity lock server-side enforcement underspecified [62/100] --
   TDD mentioned "rejects further messages" without defining mechanism.
   Resolution: Explicit ws.locked flag protocol added. Server checks
   locked state on every message, rejects all except unlock (re-auth).

3. Reconnect vs lock race condition [55/100] -- Auto-reconnect with
   stored session token could bypass inactivity lock if timer was
   per-WS-object (dies on disconnect).
   Resolution: Decision #10 added. Inactivity timer tracks per session
   token (survives WS disconnect). Reconnect triggers immediate lock
   check before accepting commands.

## Info

4. Session persistence only survives WS disconnect, not server restart [25/100]
5. Bundled xterm.js lacks integrity hashes in TDD [22/100]
6. CSP unsafe-inline for styles -- xterm.js requirement [20/100]

## Existing Protections

10 security controls survive the migration unchanged: E2E encryption
(ECDH + AES-256-GCM), IP binding (becomes device-binding on Tailscale),
30-min session token TTL with rotation, dual rate limiting (per-IP +
global), localhost-only setup page, 8h auto-shutdown, scrollback
redaction, anti-downgrade enforcement, TOFU key pinning, audit trail.
Security posture: STRONG.

## Pipeline Decision

CRITICAL: 0 remaining (1 resolved in TDD update). PASS.
WARNING: 0 remaining (2 resolved in TDD update).
INFO: 3 (logged for awareness).
