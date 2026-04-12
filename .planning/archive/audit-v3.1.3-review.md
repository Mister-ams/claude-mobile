---
project: claude-mobile
type: audit
status: active
created: 2026-03-23
updated: 2026-03-23
source: dt.review full mode (4 agents)
---

# Audit: claude-mobile v3.1.3 Full Review

Review mode: Full (4 agents: Code Quality, Bug Scan, Silent Failures, Test Coverage)
Scope: server.js (1605 LOC), public/index.html (2177 LOC), install.sh (373 LOC), update.sh (97 LOC)
Date: 2026-03-23

## Must Fix (19)

### Security / Correctness

| # | Agent | Location | Description | Score |
|---|-------|----------|-------------|-------|
| 1 | F2 | server.js:920-926 | Reattach leaks onData/onExit handlers -- rapid dtach flaps accumulate duplicate handlers, multiplying scrollback writes and broadcasts | 95 |
| 2 | F4 | server.js:270-307 | secureReceive accepts sequence gaps (1->9999) -- attacker can advance counter, permanently locking out legitimate packets | 95 |
| 3 | F4 | server.js:331-341 | validateSessionToken skips IP check when stored IP is 'unknown' -- token accepted from any IP | 92 |
| 4 | F2 | server.js:249-252 | secureSend falls through to plaintext for ANY message type pre-encryption, not just key-exchange | 90 |
| 5 | F2 | server.js:178-195 | derToP1363 hand-rolled DER parser doesn't handle multi-byte BER length -- silent TOFU breakage possible | 92 |
| 6 | F2 | server.js:1271 + index.html:1271 | Scrollback chunked writer appends extra \n per 50-line chunk -- ~100 blank lines injected on reconnect replay | 88 |
| 7 | F4 | server.js:63-66 | Shell injection via single-quote in project dir (cd '${wslDir}' unsanitized) | 87 |
| 8 | F2 | server.js:370-371 | recordGlobalFailure checks unfiltered array length -- stale entries trigger premature lockout | 85 |
| 9 | F2 | server.js:1231-1233 | config.projects[0].dir crashes if config.projects is empty array -- TypeError hangs WS | 85 |

### Silent Failures (crash/lockout risk)

| # | Agent | Location | Description | Score |
|---|-------|----------|-------------|-------|
| 10 | F3 | server.js:17 | No try/catch on config.json read -- missing/corrupt file = PM2 restart loop with no diagnostic | 95 |
| 11 | F1,F3 | server.js:404 | Empty catch in audit() itself -- disk full = complete loss of security audit trail | 95 |
| 12 | F3 | server.js:466 | saveCredentials() has zero error handling -- disk error permanently breaks passkey auth on restart | 95 |
| 13 | F1,F3 | server.js:115-119 | Empty catch in loadTotpSecret -- corrupt JSON = server appears unconfigured, all remote users locked out | 92 |
| 14 | F1,F3 | server.js:155-159 | Empty catch in loadOrCreateIdentityKey -- corrupt file silently generates new keypair, looks like MiTM to all clients | 92 |
| 15 | F3 | server.js:969-971 | Empty catch on proc.write('cmd.exe /c claude\r') -- session exists but Claude never starts, no error shown | 92 |
| 16 | F3 | server.js:862-865 | broadcastAll has no per-client try/catch -- one CLOSING socket throws, all remaining clients miss the broadcast | 88 |
| 17 | F3 | server.js:1326-1332 | Close handler doesn't clearTimeout(encryptionTimeout) -- fires on already-closed socket | 88 |
| 18 | F1,F3 | server.js:55 | Empty catch in listDtachSessions -- WSL down = "no sessions" with no diagnostic, recovery silently skipped | 95 |
| 19 | F1,F3 | server.js:96 | Empty catch in killDtachSession -- failed kill leaves zombie dtach sockets | 95 |

## Should Fix (12)

| # | Agent | Location | Description | Score |
|---|-------|----------|-------------|-------|
| 1 | F3 | server.js:958 | Windows timeout command in execSync with empty catch -- platform-specific, fails silently on non-Windows | 78 |
| 2 | F1 | server.js:686 | Failed passkey auth doesn't call recordIPFailure/recordGlobalFailure -- passkeys bypass rate limiting | 75 |
| 3 | F1 | server.js:1042-1333 | WS message handler is 290 lines with no top-level try/catch -- one TypeError crashes the process | 75 |
| 4 | F1 | index.html:793-794 | queueSend .catch(() => {}) swallows all encryption/send errors silently | 80 |
| 5 | F1 | index.html:1037-1039 | Passkey registration failure: console.error only, no user-visible feedback | 75 |
| 6 | F1 | index.html:1081-1083 | TOTP setup failure: same pattern, user sees nothing | 75 |
| 7 | F3 | index.html:1294 | loadProjects() empty catch -- fetch failure = empty dir, session create fails with confusing server error | 75 |
| 8 | F2 | server.js:1309-1321 | Session close lets onExit fire and double-broadcast + orphan other clients on same session | 82 |
| 9 | F4 | server.js:380-396 | Per-IP rate limiter never evicts non-locked IPs -- authAttempts Map grows unboundedly | 78 |
| 10 | F4 | server.js:887-889 | Scrollback truncation can cut mid-UTF8/mid-ANSI, corrupting replay | 70 |
| 11 | F2 | index.html:1102-1105 | Reconnect onclose -> doConnect -> ws.close() -> onclose can spawn duplicate reconnect timers | 77 |
| 12 | F1 | server.js:751 | 3-deep nested ternary for content-type extension detection | 80 |

## Strengths

- 4-tier security architecture (TOTP + WebAuthn + E2E ECDH + CSP) is well-layered
- dtach migration from tmux is a clean architectural decision -- simpler process model
- Attention detection with debounce and reason-specific vibration patterns is thoughtful
- Per-IP + global rate limiting with separate counters is defense-in-depth
- Session recovery (recoverDtachSessions) handles PM2 restarts gracefully
- Audit trail logs auth events, connections, and crypto operations
- Ring buffer approach for scrollback is memory-bounded and practical
- GPU rendering fallback chain (WebGL -> Canvas -> DOM) handles device diversity well

## Test Coverage

Zero tests exist. No test runner, no test files, no test script in package.json. 15 critical test gaps identified across security (token validation, rate limiting, crypto), session lifecycle (reattach, cleanup), and protocol (sequence numbers, encryption handshake). Pure functions (derToP1363, stripAnsi, validateSessionToken, checkGlobalRate, secureReceive) are immediately unit-testable.

## Summary

4 files, 31 findings, 19 must-fix. Three highest-priority clusters:
1. Empty catches on security-critical paths (audit, TOTP, identity key, credentials)
2. Plaintext fallback + sequence gap in E2E protocol
3. Zero test coverage on a security-sensitive codebase
