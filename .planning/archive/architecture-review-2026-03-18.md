---
project: claude-mobile
type: guide
status: active
created: 2026-03-18
updated: 2026-03-18
---

# Architecture Review: claude-mobile

## Summary

6 patterns found: 1 high-impact (no-action), 3 medium, 2 low.
3 findings applied (timers, session lookup, dead dependency). 2 no-action (intentional). 1 already fixed.

## Findings

| # | Pattern | Category | Impact | Freq | Effort | Status |
|---|---------|----------|--------|------|--------|--------|
| 1 | Monolithic index.html | consistency | high | 1 | medium | no-action (intentional) |
| 2 | Auth state HTTP+WS bridge | duplication | medium | 2 | medium | no-action (correct pattern) |
| 3 | Three overlapping setInterval timers | consistency | medium | 3 | small | FIXED (1f9b191) |
| 4 | Session lookup repeated in switch cases | duplication | medium | 5 | small | FIXED (1f9b191) |
| 5 | qrcode-terminal in package.json | consistency | low | 1 | small | FIXED (1f9b191) |
| 6 | challengeId vs expectedChallenge mismatch | consistency | low | 2 | small | already fixed (a42edd6) |

## Detailed Write-ups

### 1. Monolithic index.html (no-action)

1,918 lines in a single HTML file (~500 CSS, ~1,300 JS, ~100 HTML). No build step.
Intentional for zero-build single-file deployment. Acceptable for a personal tool.
If the file grows past ~2,500 lines, consider splitting JS into public/app.js.

### 2. Auth state HTTP+WS bridge (no-action)

WebAuthn requires HTTP (navigator.credentials API). The pattern of HTTP auth ->
session token -> WS auth-passkey message is the correct architecture. No change.

### 3. Consolidated housekeeping timer (fixed)

Three setInterval timers (token cleanup at 5min, IP cleanup at 5min, session
expiry+inactivity at 60s) merged into one 60s housekeeping loop. Cleaner,
single point of maintenance.

### 4. Session lookup deduplication (fixed)

Pre-resolve `activeSession` (current WS session) and `targetSession` (msg.session)
before the switch statement. Removed 5 redundant `sessions.get()` calls and
flattened nesting in input/resize/rename/close handlers.

### 5. Dead dependency (fixed)

qrcode-terminal was still in package.json after the import was removed during
ngrok cleanup. Removed.
