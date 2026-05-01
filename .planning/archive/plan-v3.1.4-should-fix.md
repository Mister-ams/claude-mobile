---
project: claude-mobile
type: plan
status: archived
created: 2026-03-24
updated: 2026-05-01
source: .planning/audit-v3.1.3-review.md
---

# Plan: v3.1.4 Should-Fix (12 items)

Source: audit-v3.1.3-review.md Should Fix section
Scope: server.js, public/index.html
Tasks: 12 | Waves: 3 | Parallel-eligible: 12

## Wave 0 -- Server Stability (3 tasks, all parallel)

### T01: Add top-level try/catch to WS message handler

**Domain**: api
**Action**: modify
**Files**: server.js (lines 1137-1390)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #3 (score 75)
**Fix**: Wrap the entire `ws.on('message', ...)` body in try/catch after
`secureReceive`. On catch, `audit('ERROR', 'Message handler error: ' + e.message)`
and do NOT re-throw (prevents process crash). Close the offending WS.
**Verification**: Send a malformed encrypted message. Confirm server stays up
and audit entry appears.

### T02: Guard session close against onExit double-broadcast

**Domain**: api
**Action**: modify
**Files**: server.js (lines 1365-1380)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #8 (score 82)
**Fix**: In the `close` case handler, null out `session.proc` before calling
`proc.kill()` so the `onExit` handler (which checks the proc) can detect the
session is already being torn down. Add `if (!session.proc) return;` guard at
the top of the onExit callback in wireSessionProc.
**Verification**: Close a session while another client is attached. Confirm
session-list broadcast fires once, not twice.

### T03: Add eviction for non-locked IPs in authAttempts housekeeping

**Domain**: api
**Action**: modify
**Files**: server.js (housekeeping interval, ~line 1410)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #9 (score 78)
**Fix**: In the housekeeping interval, also evict authAttempts entries where
`count < MAX_AUTH_ATTEMPTS` and last attempt was > AUTH_LOCKOUT_MS ago. Add
a `lastAttempt` timestamp to the entry in `recordIPFailure`.
**Verification**: Add 100 unique IPs with count=1. Confirm housekeeping
reduces map size after the lockout window passes.

## Wave 1 -- Security & Protocol (4 tasks, all parallel)

### T04: Replace Windows timeout with setTimeout for dtach socket wait

**Domain**: api
**Action**: modify
**Files**: server.js (line 1019)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #1 (score 78)
**Fix**: Replace `execSync('timeout /t 1 ...')` with a promise-based approach:
wrap `attachToDtach` in a retry with 200ms delay (max 5 attempts) checking
socket existence via `dtachSessionAlive`. Remove the platform-specific sleep.
**Verification**: Create a session on non-Windows host (WSL). Confirm no
`timeout` command error.

### T05: Rate-limit failed passkey auth attempts

**Domain**: api
**Action**: modify
**Files**: server.js (line 686, passkey auth-verify handler)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #2 (score 75)
**Fix**: In the `else` branch of `if (verification.verified)`, add
`recordIPFailure(ip)` and `recordGlobalFailure(ip)` to match the TOTP
failure path.
**Verification**: Send 5 failed passkey attempts. Confirm IP lockout triggers.

### T06: Log queueSend errors instead of swallowing

**Domain**: frontend
**Action**: modify
**Files**: public/index.html (line 793-794)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #4 (score 80)
**Fix**: Replace `.catch(() => {})` with
`.catch(e => clientLog('queueSend error: ' + e.message))`.
**Verification**: Confirm no silent swallow -- check server logs for
client-log messages on encryption failure.

### T07: Prevent duplicate reconnect timers

**Domain**: frontend
**Action**: modify
**Files**: public/index.html (lines 1102-1105)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #11 (score 77)
**Fix**: Add a `reconnectTimer` variable. Before scheduling a new
`setTimeout(() => doConnect('reconnect'), ...)`, clear any existing timer:
`clearTimeout(reconnectTimer)`. Assign the new timer ID to `reconnectTimer`.
**Verification**: Disconnect rapidly 3 times. Confirm only one reconnect
attempt fires (check server audit log for connection count).

## Wave 2 -- Client UX & Code Quality (5 tasks, all parallel)

### T08: Show user feedback on passkey registration failure

**Domain**: frontend
**Action**: modify
**Files**: public/index.html (lines 1037-1039)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #5 (score 75)
**Fix**: Replace `console.error(...)` with
`showStatus('Passkey registration failed: ' + e.message, 'error')`.
**Verification**: Cancel Face ID prompt. Confirm status message appears.

### T09: Show user feedback on TOTP setup failure

**Domain**: frontend
**Action**: modify
**Files**: public/index.html (lines 1081-1083)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #6 (score 75)
**Fix**: Replace `console.error(...)` with
`showStatus('TOTP setup failed: ' + e.message, 'error')`.
**Verification**: Trigger a network error during TOTP setup. Confirm status
message appears.

### T10: Show feedback on loadProjects failure

**Domain**: frontend
**Action**: modify
**Files**: public/index.html (line 1294)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #7 (score 75)
**Fix**: Replace empty catch with
`catch (e) { clientLog('loadProjects failed: ' + e.message); }`.
**Verification**: Block /api/projects fetch. Confirm client-log message
appears in server logs.

### T11: Safe scrollback truncation at UTF-8 boundary

**Domain**: api
**Action**: modify
**Files**: server.js (lines 945-948, scrollback slice)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #10 (score 70)
**Fix**: After `session.scrollback = session.scrollback.slice(-SCROLLBACK_SIZE)`,
scan the first few bytes for a broken UTF-8 sequence (leading byte 0x80-0xBF
without preceding multi-byte start). If found, skip forward to the next valid
start byte. This prevents mid-character truncation.
**Verification**: Write a string with multi-byte UTF-8 chars at the truncation
boundary. Confirm replayed scrollback has no replacement characters.

### T12: Replace nested ternary with lookup map for content-type

**Domain**: api
**Action**: modify
**Files**: server.js (line 751)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: should-fix #12 (score 80)
**Fix**: Replace the 3-deep ternary with:
```
const EXT_MAP = { png: '.png', jpeg: '.jpg', jpg: '.jpg', webp: '.webp' };
const ext = Object.entries(EXT_MAP).find(([k]) => ct.includes(k))?.[1] || '.png';
```
**Verification**: Upload images with different content types. Confirm correct
file extensions assigned.

## Verification Mapping

| # | Finding | Verified By | Check Type |
|---|---------|-------------|------------|
| V01 | #3 WS handler catch | T01 | manual (malformed message) |
| V02 | #8 double-broadcast | T02 | manual (close with 2 clients) |
| V03 | #9 map eviction | T03 | manual (inspect map size) |
| V04 | #1 platform sleep | T04 | manual (session create) |
| V05 | #2 passkey rate limit | T05 | manual (5 failed attempts) |
| V06 | #4 queueSend logging | T06 | manual (check server logs) |
| V07 | #11 reconnect dedup | T07 | manual (rapid disconnect) |
| V08 | #5 passkey feedback | T08 | manual (cancel Face ID) |
| V09 | #6 TOTP feedback | T09 | manual (network error) |
| V10 | #7 loadProjects feedback | T10 | manual (block fetch) |
| V11 | #10 UTF-8 truncation | T11 | manual (multi-byte boundary) |
| V12 | #12 content-type ternary | T12 | manual (upload test) |

## Risk Summary

All tasks low risk. No high-risk items in this batch.
