---
project: claude-mobile
type: plan
status: draft
created: 2026-04-03
updated: 2026-04-03
source: (re-review findings -- no formal tech-design)
executor-domains: api, frontend
---

# Plan: v3.1.6 Re-Review Fixes

## Overview

10 tasks across 2 waves fixing all findings from the post-v3.1.6 re-review.
3 are regressions introduced by v3.1.6, 4 are residual issues from the
original codebase, 3 are hardening improvements. All surgical edits in
server.js and public/index.html. No architectural changes.

## Dependency Graph

```
Wave 0: T01 T02 T03 T04 T05 T06 T07 T08 T09 (all independent)
Wave 1: T10 (verification, depends on all)
```

All fixes are independent -- single wave of parallel edits + verification.

---

## Wave 0 -- All Fixes (parallel)

### T01: Fix autoStartSessions to await async createSession
**Domain**: api
**Action**: modify
**Files**: `server.js:1763-1772`
**Depends on**: none
**Risk**: medium (startup path, affects session recovery)
**Parallel**: yes
**Effort**: small (~8 lines)
**Verification**: `node -c server.js` + check PM2 logs for "Auto-started" after restart

Make `autoStartSessions` async. Add `await` before `createSession`. Wrap in
try/catch to log failures. Call site at startup (line 1808) already handles
sync/async since it doesn't use the return value.

### T02: Drop plaintext messages in secureSend after E2E was active
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html:774-778`
**Depends on**: none
**Risk**: medium (affects message sending)
**Parallel**: yes
**Effort**: small (~5 lines)
**Verification**: grep for `ws.send(JSON.stringify` -- should only appear in
key-exchange (line 765) and pre-E2E path

When `e2eSendSeq > 0` (E2E was previously active), drop the message and log
instead of sending plaintext. The key-exchange response at line 765 uses
`ws.send()` directly, so the secureSend fallback is only needed for pre-E2E
messages during initial handshake.

### T03: Cap decrypt-failure reconnect cycles
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html:825-829`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~8 lines)
**Verification**: grep for `decryptReconnectCount`

Add `let decryptReconnectCount = 0` near e2e state vars. On decrypt-triggered
reconnect, increment. If >= 3, show persistent error and stop reconnecting.
Reset only on successful auth (not on doConnect).

### T04: Add logging to scanSkillDir readdirSync catch
**Domain**: api
**Action**: modify
**Files**: `server.js:1634`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (1 line)
**Verification**: grep `scanSkillDir` for `audit`

Change `catch { return skills; }` to
`catch (e) { audit('WARN', 'scanSkillDir: ' + e.message); return skills; }`

### T05: Add logging to ws.close in error handler
**Domain**: api
**Action**: modify
**Files**: `server.js:1538`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (1 line)
**Verification**: grep for remaining `catch {}` in server.js (should be 0)

### T06: Show UI feedback on first decrypt failure
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html:823-829`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~3 lines)
**Verification**: grep for `showStatus.*decrypt`

On first decrypt failure, show transient warning via showStatus. Existing
behavior (reconnect after 3) preserved.

### T07: Log gap detection in client replay check
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html:808`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~3 lines)
**Verification**: grep for `gap detected`

When `parsed.n > e2eRecvSeq + 1`, log via clientLog before accepting.

### T08: Check saveCredentials return value in callers
**Domain**: api
**Action**: modify
**Files**: `server.js:755,817`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~6 lines)
**Verification**: grep `saveCredentials` for `if (!`

At passkey register-verify (line 755) and auth-verify (line 817), check
return value. On failure, log warning. Registration failure should warn
client; counter update failure should log critical.

### T09: Log clipboard error detail in TOTP setup
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html:1075`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (1 line)
**Verification**: grep `Clipboard` for `e.message`

Change `console.warn('Clipboard unavailable, copy manually')` to include
`e.message`.

### T10: Client secureReceive JSON parse logging
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html:803`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (1 line)
**Verification**: grep `JSON parse` in index.html

Add `clientLog('JSON parse failed')` to match server-side pattern.

---

## Wave 1 -- Verification

Syntax check, PM2 restart, phone test. Tag v3.1.7 after verification.

---

## Domain Summary

| Domain | Tasks | Executor |
|--------|-------|----------|
| api | T01, T04, T05, T08 | /dt.execute |
| frontend | T02, T03, T06, T07, T09, T10 | /dt.execute |

## Verification Matrix

| # | Finding | Verified By | Check | Type |
|---|---------|-------------|-------|------|
| V1 | autoStartSessions await | T01 | `node -c server.js` + PM2 logs | auto |
| V2 | No plaintext after E2E | T02 | grep ws.send in secureSend path | auto |
| V3 | Reconnect loop capped | T03 | grep decryptReconnectCount | auto |
| V4 | scanSkillDir logging | T04 | grep `catch {}` server.js = 0 | auto |
| V5 | ws.close logging | T05 | grep `catch {}` server.js = 0 | auto |
| V6 | Decrypt UI feedback | T06 | grep showStatus.*decrypt | auto |
| V7 | Gap logging | T07 | grep gap in index.html | auto |
| V8 | Credential save check | T08 | grep saveCredentials callers | auto |
| V9 | Clipboard error detail | T09 | grep e.message near Clipboard | auto |
| V10 | JSON parse client log | T10 | grep JSON parse in index.html | auto |

## Risk Summary

| Level | Count | Tasks | Mitigation |
|-------|-------|-------|------------|
| Medium | 2 | T01, T02 | Verify phone connects after PM2 restart |
| Low | 8 | T03-T10 | Standard grep verification |

## Execution Notes

- All 10 tasks are independent -- execute in a single wave
- T01 is the most critical (startup regression)
- T02 is a security fix (plaintext leak)
- T03 prevents infinite reconnect loops
- T04-T10 are one-liners or near one-liners
- Commit as single commit, tag v3.1.7, push + PM2 restart + phone test
