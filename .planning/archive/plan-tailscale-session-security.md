---
project: claude-mobile
type: plan
status: draft
created: 2026-03-18
source: .planning/tech-design-tailscale-session-security.md
feature: tailscale-session-security
---

# Plan: Tailscale Migration + Session Persistence + Security Fixes

## Domain Summary

| Domain | Tasks | Notes |
|--------|-------|-------|
| config | 3 | xterm bundling, config.json, package.json |
| api | 4 | server.js modifications (ngrok removal, CSP, inactivity, startup) |
| frontend | 3 | index.html modifications (vendor paths, reattach, lock UI) |
| infrastructure | 1 | install.sh + update.sh (Tailscale setup) |

All domains execute within 2 files (server.js, index.html) + config/scripts.

---

## Wave 0: Foundation -- Bundle xterm.js Locally

### T01: Download xterm.js files to public/vendor/

**Domain**: config | **Action**: create | **Risk**: low | **Effort**: small
**Files**: public/vendor/xterm.min.js, public/vendor/xterm.min.css, public/vendor/addon-fit.min.js
**Depends on**: none
**Verification**: `ls public/vendor/` shows 3 files; file sizes match npm package versions
**Notes**: Download from npm registry or jsdelivr. Versions: @xterm/xterm@5.5.0 (JS+CSS), @xterm/addon-fit@0.10.0. Add vendor/ to .gitignore exception if needed.

### T02: Update index.html to load xterm from vendor/

**Domain**: frontend | **Action**: modify | **Risk**: low | **Effort**: small
**Files**: public/index.html
**Depends on**: T01
**Verification**: Page loads with terminal rendering; no network requests to jsdelivr in DevTools Network tab.
**Notes**: Replace 3 CDN references (lines 10, 578, 579) with relative paths: `/vendor/xterm.min.css`, `/vendor/xterm.min.js`, `/vendor/addon-fit.min.js`.

---

## Wave 1: Network Migration -- Remove ngrok, Add Tailscale + CSP

### T03: Remove ngrok code, add Tailscale config to server.js

**Domain**: api | **Action**: modify | **Risk**: medium | **Effort**: medium
**Files**: server.js
**Depends on**: T01, T02
**Verification**: Server starts without ngrok. `rpID` reads from config.tailscaleHostname. `getClientIP()` returns direct socket IP (no X-Forwarded-For). E2E key exchange completes (check audit log for 'E2E session established').
**Notes**:
- Delete `startTunnel()` function and `NGROK_DOMAIN` const (~lines 1097-1145)
- Delete `showLocalQR()` function (~lines 1147-1150)
- Remove `startTunnel()` call from server.listen callback (~line 1174)
- Update `rpID` and `expectedOrigin` to read from `config.tailscaleHostname`:
  `rpID = config.tailscaleHostname; expectedOrigin = 'https://' + config.tailscaleHostname;`
- Simplify `getClientIP()`: remove X-Forwarded-For parsing (not behind proxy anymore)
- Bind to `localhost` instead of `0.0.0.0` (tailscale serve proxies externally)
- Update startup console output (remove tunnel URL, show Tailscale hostname)
- Decision #9 (locked): TLS via tailscale serve, not Express

### T04: Update config.json and config.example.json

**Domain**: config | **Action**: modify | **Risk**: low | **Effort**: small
**Files**: config.json, config.example.json
**Depends on**: none (parallel with T03)
**Verification**: `node -e "const c=require('./config.json'); console.log(c.tailscaleHostname, c.inactivityTimeout)"` prints values.
**Notes**:
- Remove `ngrokDomain` field
- Add `tailscaleHostname` (string, e.g. "desktop.tail1234.ts.net")
- Add `inactivityTimeout` (number, minutes, default 15)
- Decision #6 (discretion): default 15 min, executor may adjust

### T05: Add CSP middleware to Express

**Domain**: api | **Action**: modify | **Risk**: low | **Effort**: small
**Files**: server.js
**Depends on**: T01 (vendor/ must exist for script-src 'self')
**Verification**: `curl -I http://localhost:3456/ | grep Content-Security-Policy` shows the full CSP header.
**Notes**:
- Add middleware before `express.static()` (~line 424)
- Policy from TDD: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
- Decision #3 (locked): script-src 'self' only (no CDN)

---

## Wave 2: Session Resilience -- Reconnect Reattach + Server-Side Inactivity

### T06: Add session auto-reattach on reconnect

**Domain**: frontend | **Action**: modify | **Risk**: medium | **Effort**: small
**Files**: public/index.html
**Depends on**: T03
**Verification**: Connect to session, disconnect WiFi, reconnect -- terminal shows previous session with scrollback intact, no manual re-selection needed.
**Notes**:
- Reconnect with backoff already exists (exponential, capped 30s)
- Add: store `lastActiveSession` variable (set on connect, cleared on close)
- After reconnect + successful auth, check if lastActiveSession exists in received sessions list
- If yes, auto-send `{ type: 'connect', session: lastActiveSession }`
- If no (session was killed), show session list as normal

### T07: Add server-side inactivity tracking and lock protocol

**Domain**: api | **Action**: modify | **Risk**: medium | **Effort**: medium
**Files**: server.js
**Depends on**: none (parallel with T06)
**Verification**: Set inactivityTimeout to 1 in config. Wait 70s. Server sends `{ type: 'lock' }`. Subsequent messages rejected with `{ type: 'error', message: 'Locked' }` until unlock.
**Notes**:
- Add `lastActivity` field to sessionTokens Map entries (alongside expires, ip)
- Update `lastActivity` on every authenticated WS message
- Add `ws.locked` flag, default false
- On every message handler: check if locked, reject unless `msg.type === 'unlock'`
- Add interval (60s): for each authenticated WS client, check if `Date.now() - token.lastActivity > config.inactivityTimeout * 60000`. If yes, set `ws.locked = true`, send `{ type: 'lock' }`
- Add unlock handler: `msg.type === 'unlock'` with passkey sessionToken or TOTP code
- On successful unlock: `ws.locked = false`, send `{ type: 'unlocked' }`
- Decision #10 (locked): timer is per session token, not per WS object
- On reconnect with valid but inactive token: immediately send lock before accepting commands

---

## Wave 3: Client Lock UI + Scripts + Cleanup

### T08: Add inactivity lock overlay and re-auth UI to client

**Domain**: frontend | **Action**: modify | **Risk**: medium | **Effort**: large
**Files**: public/index.html
**Depends on**: T07
**Verification**: Set inactivityTimeout to 1. Wait idle. Lock overlay covers terminal. Face ID button works (or TOTP fallback). After unlock, terminal is interactive again.
**Notes**:
- Add client-side inactivity timer: reset on touch/keydown/mousemove/click
- After N minutes (read from server config or hardcode matching server), show lock overlay
- Lock overlay: full-screen, Palantir theme, covers terminal, no click-through
- Face ID button: triggers WebAuthn authentication flow (navigator.credentials.get)
- On passkey success: send `{ type: 'unlock', sessionToken: <from passkey auth> }`
- TOTP fallback: show TOTP input field if passkey fails or not available
- On TOTP success: send `{ type: 'unlock', totp: <code> }`
- Handle server `{ type: 'lock' }` message: show overlay immediately
- Handle server `{ type: 'unlocked' }` message: hide overlay, resume
- Decision #2 (locked): passkey primary, TOTP fallback

### T09: Update install.sh for Tailscale setup

**Domain**: infrastructure | **Action**: modify | **Risk**: low | **Effort**: medium
**Files**: install.sh
**Depends on**: T03, T04
**Verification**: Read install.sh -- no ngrok references remain. Tailscale setup instructions present. `tailscale serve` configuration documented.
**Notes**:
- Remove ngrok setup section (~lines 99-177)
- Add Tailscale setup section:
  - Check if tailscale CLI is installed
  - Guide user to install Tailscale (Windows: winget, macOS: brew, Linux: curl)
  - Check `tailscale status` for active connection
  - Get MagicDNS hostname from `tailscale status --json`
  - Configure `tailscale serve https / http://localhost:3456`
  - Write tailscaleHostname to config.json
- Update config.json template to use new fields
- Add passkey re-registration note (rpID changed)

### T10: Update update.sh for vendor/ and new config fields

**Domain**: config | **Action**: modify | **Risk**: low | **Effort**: small
**Files**: update.sh
**Depends on**: none (parallel with T09)
**Verification**: Read update.sh -- vendor/ update step present. Preserved files list includes new config fields.
**Notes**:
- Add vendor/ check: if xterm version changed in update, re-download vendor files
- Update preserved files message (~line 88) to mention new config fields
- No ngrok references remain

### T11: Tailscale startup check, passkey guidance, version bump

**Domain**: api | **Action**: modify | **Risk**: low | **Effort**: small
**Files**: server.js, package.json
**Depends on**: T03
**Verification**: Start server without Tailscale running -- console shows warning. Start with Tailscale -- shows hostname. package.json version incremented.
**Notes**:
- Add startup check: detect Tailscale interface in os.networkInterfaces() (look for 100.x.y.z address)
- If no Tailscale detected: log warning "Tailscale not detected -- server accessible on localhost only"
- If Tailscale detected: log "Tailscale: https://<hostname>"
- On first start after migration (detect: config has tailscaleHostname but no .credentials.json or passkeys empty): log "Passkeys must be re-registered -- visit https://<hostname>/setup"
- Bump package.json version to 2.0.0 (major: breaking change, ngrok removed)

---

## Verification Matrix

| # | Criterion (from TDD) | Verified By | Check |
|---|----------------------|-------------|-------|
| V1 | Server via HTTPS on Tailscale MagicDNS, not public internet | T03, T09 | Browser opens https://<hostname>, cert valid |
| V2 | Browser shows valid Let's Encrypt cert | T09 | tailscale serve active, browser padlock icon |
| V3 | Sessions survive WS disconnect + reconnect with scrollback | T06 | Disconnect WiFi, reconnect, scrollback present |
| V4 | CSP header on all HTTP responses | T05 | curl -I shows Content-Security-Policy |
| V5 | Lock overlay after idle, Face ID unlocks, TOTP fallback | T07, T08 | Set timeout=1min, wait, verify lock+unlock |
| V6 | E2E encryption handshake completes over Tailscale | T03 | Audit log shows 'E2E session established' |
| V7 | TOTP login works with new rpID | T03 | Login with TOTP code after migration |
| V8 | New passkey registration via /setup | T03, T11 | Register passkey on Tailscale hostname |
| V9 | xterm.js loads from local vendor/ | T01, T02 | DevTools Network tab: no jsdelivr requests |
| V10 | Scrollback redaction, attention, upload work | T06 | Functional smoke test post-migration |

---

## Risk Summary

| Risk Level | Count | Tasks |
|------------|-------|-------|
| Low | 6 | T01, T02, T04, T05, T09, T10 |
| Medium | 5 | T03, T06, T07, T08, T11 |
| High | 0 | -- |

Highest risk: T03 (ngrok removal touches core server startup + WebAuthn config) and T08 (lock overlay UI in 1800-line HTML file).
