---
project: claude-mobile
type: plan
status: draft
created: 2026-04-03
updated: 2026-04-03
source: (architecture review findings -- skip modularization)
executor-domains: api, frontend
---

# Plan: Architecture Cleanup (Quick Wins + Client Cleanup)

## Overview

10 tasks across 3 waves. Addresses 8 of 10 architecture review findings
(skipping server.js and index.html monolith extraction). Pure refactoring --
zero feature changes. Tag v3.2.0 after verification.

## Dependency Graph

```
Wave 0: T01 T02 T03 T04 T05 (all independent)
Wave 1: T06 T07 T08 (independent, depend on Wave 0 for clean baseline)
Wave 2: T09 T10 (verification)
```

---

## Wave 0 -- Trivial Fixes (all parallel)

### T01: Fix stale tmux comment in client
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (1 line)
**Verification**: grep "tmux" in index.html -- should return 0 hits

Find and fix any comments referencing tmux (system uses dtach since v3.1.3).

### T02: Rename client `sessions` to `sessionList`
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~15 replacements)
**Verification**: grep `[^.]sessions` in index.html for stale references.
Must not break `m.sessions` (incoming message field) or `msg.sessions`.

Rename the client-side `sessions` array variable to `sessionList` to avoid
collision with server-side `sessions` Map concept. Only rename the local
variable and its usages, NOT the wire protocol field (`m.sessions`).

### T03: Normalize auth response shapes
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: none
**Risk**: medium (touches auth flow)
**Parallel**: yes
**Effort**: small (~5 lines)
**Verification**: grep `verified:` in server.js -- should only appear in
passkey register-verify (non-auth response). Auth responses should all
use `success:`.

Passkey auth-verify at line ~820 returns `{ verified: true, sessionToken }`.
Change to `{ success: true, sessionToken }` to match completeAuth pattern.
Update client passkey auth handler if it checks `verified`.

### T04: Extract checkRateLimit helper
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~10 lines)
**Verification**: grep `checkGlobalRate.*checkIPRate` -- should appear once
(in the helper), not 4 times.

Create `function checkRateLimits(ip)` that combines `checkGlobalRate()` and
`checkIPRate(ip)`. Replace the 4 duplicate guard sites.

### T05: Extract verifyTotpAndRespond helper
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~15 lines)
**Verification**: grep `verifyTotp(req.body` -- should appear once (in helper).

Three endpoints repeat: check TOTP code, return verified true/false.
Extract shared helper. Preserve per-endpoint differences (localhost check,
lockout clearing, audit messages).

---

## Wave 1 -- Client Cleanup (all parallel)

### T06: Extract CSS into public/style.css
**Domain**: frontend
**Action**: create + modify
**Files**: `public/style.css` (new), `public/index.html`
**Depends on**: T01, T02 (clean baseline)
**Risk**: medium (large move, no test suite)
**Parallel**: yes
**Effort**: medium (~515 lines moved)
**Verification**: page loads with correct styling in browser.
grep `<style>` in index.html -- should have 0 hits (all in style.css).

Move all CSS from `<style>` tags in index.html to `public/style.css`.
Replace with `<link rel="stylesheet" href="/style.css">`.
Keep inline `style` attributes on elements unchanged.

### T07: Merge login/lock screen into single auth UI
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: T01, T02 (clean baseline)
**Risk**: medium (auth UX)
**Parallel**: yes
**Effort**: medium (~30 lines net reduction)
**Verification**: login flow works (TOTP entry), lock screen works
(shows after inactivity timeout). Both use same UI component.

`#pin-screen` and `#lock-screen` are near-identical: TOTP input + passkey
button + error display. Merge into single `#auth-screen` with a mode flag
(login vs unlock). JS functions `showLockScreen`/`showPinScreen` set the
mode and update the heading text.

### T08: Extract setup pages from server.js into public/setup.html
**Domain**: api + frontend
**Action**: create + modify
**Files**: `public/setup.html` (new), `server.js`
**Depends on**: none
**Risk**: medium (setup flow)
**Parallel**: yes
**Effort**: medium (~80 lines moved from server.js, ~120 line HTML file)
**Verification**: visit http://localhost:3456/setup -- page loads,
TOTP setup works, re-enrollment works.

Move the two inline HTML template literals from `/setup` GET handler
(server.js lines ~596-674) into `public/setup.html`. The setup page
fetches auth state from a new `/api/setup/status` endpoint to decide
which view to show (initial setup vs re-enrollment).

---

## Wave 2 -- Verification

### T09: Unify error response patterns
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: T03, T04, T05
**Risk**: low
**Parallel**: yes
**Effort**: small (~10 lines)
**Verification**: grep for error response patterns -- should consistently
use `{ type: 'error', message }` for WS and `{ error: message }` for HTTP.

Audit all error responses. WS errors should use `secureSend(ws, { type: 'error',
message })`. HTTP errors should use `res.status(N).json({ error: message })`.
Fix any that deviate.

### T10: Full verification
**Domain**: test
**Action**: verify
**Files**: all
**Depends on**: T01-T09
**Risk**: low
**Parallel**: no
**Effort**: small
**Verification**: node -c server.js, PM2 restart, phone connects,
sessions visible, input works, lock screen works after inactivity.

Syntax check, restart, phone test. Tag v3.2.0.

---

## Domain Summary

| Domain | Tasks | Executor |
|--------|-------|----------|
| api | T03, T04, T05, T08, T09 | /dt.execute |
| frontend | T01, T02, T06, T07 | /dt.execute |
| test | T10 | manual |

## Risk Summary

| Level | Count | Tasks | Mitigation |
|-------|-------|-------|------------|
| Medium | 4 | T03, T06, T07, T08 | Phone test after each wave |
| Low | 6 | T01, T02, T04, T05, T09, T10 | Syntax check |

## Execution Notes

- Wave 0 is all one-liners or small helpers -- low risk, fast
- Wave 1 has the largest changes (CSS extraction, screen merge, setup extraction)
- T06 (CSS extraction) is the riskiest: 515 lines moved, no test suite
- T07 (screen merge) affects auth UX -- test both login and lock flows
- T08 (setup extraction) creates a new file + API endpoint
- All waves independently verifiable via PM2 restart + phone test
- Single commit per wave, tag v3.2.0 after T10
