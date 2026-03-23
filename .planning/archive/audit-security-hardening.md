---
project: claude-mobile
type: audit
status: active
created: 2026-03-17
updated: 2026-03-17
---

# Red Team Audit: Security Hardening P0-P2

## Critical (resolved in TDD update)

1. UNSIGNED EPHEMERAL KEY [92/100] -- Identity key must ECDSA-sign ephemeral pubkey.
   Without signature, attacker replays known identity pubkey with own ephemeral.
   Resolution: Decision #7 added to TDD. Protocol now includes `sig` field.

2. FIRST-CONNECTION MITM [82/100] -- TOFU bootstrap through compromised tunnel.
   Resolution: Decision #8 added. /setup page displays fingerprint for OOB verification.
   Client requires tap-to-confirm on first pin.

## Warning (addressed in TDD)

3. No replay protection [88/100] -- Counter-based nonces + sequence AAD added (Decision #10).
4. getClientIP() returns ngrok peer IP [85/100] -- X-Forwarded-For extraction added (Decision #11).
5. HTTP /api/auth/refresh leaks tokens [85/100] -- Deprecated, WS path preferred (Decision #6).
6. No downgrade protection [82/100] -- Mandatory encryption enforced (Decision #9).
7. validateSessionToken() needs IP param [65/100] -- Implementation detail for task breakdown.
8. Nonce collision risk [72/100] -- Counter-based IV eliminates birthday bound (Decision #10).
9. HKDF missing salt/key binding [72/100] -- Salt + pubkey binding added to protocol step 8.

## Info

10. Key exchange failure = close connection [70/100]
11. .server-identity-key file permissions [70/100]
12. Client-side send queue for async crypto [55/100]
13. P-256 adequate for threat model [40/100]
14. Encrypted message size = timing side channel [45/100]
15. No channel binding HTTP auth <-> WS session [68/100]

## Existing Protections

16 security controls identified, 14 fully implemented. Design layers cleanly.
Strong: TOTP, WebAuthn, localhost setup, dual rate limiting, env whitelist,
auto-shutdown, directory allowlisting, audit trail, scrollback redaction.

## Pipeline Decision

CRITICAL: 0 remaining (2 resolved in TDD). PASS.
