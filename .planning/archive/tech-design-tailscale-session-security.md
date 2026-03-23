---
project: claude-mobile
type: spec
status: draft
created: 2026-03-18
updated: 2026-03-18
source: .planning/requirements-tailscale-session-security.md
---

# Technical Design: Tailscale Migration + Session Persistence + Security Fixes

## Overview

Replaces ngrok with Tailscale VPN for zero-public-surface networking, adds
server-managed session persistence (pty survives WebSocket disconnect), bundles
xterm.js locally, adds CSP headers, and implements an inactivity lock with
Face ID re-auth. E2E encryption (ECDH + AES-256-GCM) is retained as
defense-in-depth over WireGuard.

## Current State

- `server.js:1097-1145` -- `startTunnel()` spawns ngrok process, sets rpID/expectedOrigin to ngrok domain
- `server.js:403-404` -- `rpID = 'localhost'`, `expectedOrigin = 'http://localhost:PORT'` (overwritten by startTunnel)
- `server.js:818-822` -- `getClientIP()` reads X-Forwarded-For (ngrok-specific)
- `server.js:1055-1061` -- `ws.on('close')` removes client from session but pty stays alive (sessions Map persists). However, if ALL clients disconnect, pty has no consumers until a new WS connects and sends `connect` message
- `server.js:802-807` -- `proc.onExit()` deletes session from Map (pty death = session gone)
- `server.js:768-770` -- session object stores `scrollback` string, already replayed on `connect` (line 988-991)
- `server.js:389-398` -- auto-shutdown after 8h idle (server-level, not client-level)
- `server.js:420-424` -- Express middleware: JSON parser + static. No CSP headers
- `public/index.html:10,578-579` -- xterm.js loaded from cdn.jsdelivr.net (3 files: CSS, xterm.min.js, addon-fit.min.js)
- `config.json` -- has `ngrokDomain` field
- `install.sh:99-177` -- ngrok setup section (detect binary, auth, get domain)
- `package.json` -- no ngrok npm dependency (spawned as system binary)
- WebAuthn passkeys are bound to rpID (currently ngrok domain) -- changing rpID invalidates all existing passkeys

## Target State

### System Design

```
Phone (Tailscale)              Dev Machine (Tailscale)
+------------------+  WireGuard  +----------------------------------+
| Safari/Chrome    |<----------->| tailscale serve (HTTPS:443)      |
| https://host.ts  |  encrypted  |   -> localhost:3456              |
| xterm.js client  |  peer-to-   | Express (localhost:3456)         |
| E2E encryption   |  peer       |   node-pty sessions              |
| inactivity lock  |             |   E2E encryption, CSP headers    |
+------------------+             |   session persistence            |
                                 +----------------------------------+
```

No public URL. No tunnel process. Server uses `tailscale serve` to terminate
TLS and proxy HTTPS:443 -> localhost:3456. Reachable via MagicDNS hostname
(e.g. desktop.tail1234.ts.net) over HTTPS. This provides a secure context
for WebAuthn passkeys without managing certificates manually.

`tailscale serve` is a built-in Tailscale feature that provisions Let's Encrypt
certificates automatically for MagicDNS hostnames and reverse-proxies to a
local port. No code changes to Express -- it still binds localhost:3456.

### Session Persistence Model

Current behavior: WS disconnect removes client from session.clients Set, but
pty process stays alive in the sessions Map. Scrollback replay already works
when a new client sends `connect`.

Gap: if the server has zero connected clients, there is no issue -- pty keeps
running. The actual gap is client-side: the client does not attempt to
reconnect or reattach after WS close. The server-side session model already
supports persistence.

Changes needed:
1. **Client reconnect**: on WS close, attempt reconnect with exponential
   backoff. After reconnect + re-auth, send `connect` for the previously
   active session to reattach and receive scrollback replay.
2. **Session list on auth**: after authentication, server sends session list
   (already happens via `broadcastSessions()`). Client auto-connects to the
   session it was previously viewing.
3. **Orphan cleanup**: add configurable session idle timeout (separate from
   inactivity lock). If a pty session has no connected clients AND no output
   for N minutes, optionally kill it. Default: no auto-kill (sessions persist
   until server restart or manual close).

### CSP Headers

Add Express middleware before static file serving:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  connect-src 'self' ws: wss:;
  img-src 'self' data: blob:;
  font-src 'self';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self'
```

`'unsafe-inline'` for style-src is required: xterm.js injects inline styles
for terminal rendering. No way around this without breaking xterm.

### Inactivity Lock

- **Client-side timer**: reset on any touch/key/mouse event. After N minutes
  (configurable, default 15), show lock overlay.
- **Lock overlay**: full-screen overlay with Face ID button. Covers terminal
  content. No interaction passes through.
- **Re-auth**: WebAuthn passkey authentication (Face ID). If passkey
  unavailable or fails, fall back to TOTP.
- **Server-side enforcement (red-team fix #2)**: server tracks `lastActivity`
  per session token in the `sessionTokens` Map (not per WS object). This
  survives WS disconnects. On any incoming WS message, server checks:
  1. Is `ws.locked === true`? If yes, reject unless `msg.type === 'unlock'`
  2. Has `lastActivity` for this token exceeded threshold? If yes, set
     `ws.locked = true`, send `{ type: 'lock' }`, reject the message.
  The `unlock` message must contain a valid passkey assertion or TOTP code.
  Only a successful unlock clears `ws.locked`.
- **Reconnect vs lock (red-team fix #3)**: inactivity timer is tracked on
  the session token, not the WS connection. If a client reconnects with a
  valid token but lastActivity exceeds threshold, the server immediately
  sends `{ type: 'lock' }` and sets `ws.locked = true` before accepting
  any commands. The reconnect succeeds (session list is sent) but the
  terminal is locked until re-auth.

### WebAuthn Migration

Changing rpID from ngrok domain to Tailscale MagicDNS hostname invalidates
all existing passkeys. This is a one-time cost. The /setup page will need
to be visited again to register new passkeys against the new rpID.

## Key Decisions

| # | Decision | Chosen | Status | Rationale |
|---|----------|--------|--------|-----------|
| 1 | WebAuthn rpID | Tailscale MagicDNS hostname | locked | Stable domain, works with passkeys. Configured in config.json as `tailscaleHostname`. |
| 2 | Lock screen re-auth | Passkey (Face ID) primary, TOTP fallback | locked | Quick biometric unlock for the common case. TOTP as backup if passkey fails. |
| 3 | xterm.js loading | Bundle locally in public/vendor/ | locked | Strict CSP (script-src 'self'), works offline on Tailscale mesh, no CDN dependency. |
| 4 | ngrok removal | Complete removal, no fallback | locked | Tailscale DERP relays handle restrictive networks. Simplest approach. |
| 5 | Session persistence | Client-side reconnect + server session reattach | locked | Server already keeps pty alive. Gap is client reconnect logic only. |
| 6 | Inactivity timeout | Configurable in config.json, default 15 min | discretion | Executor may adjust default based on testing. |
| 7 | IP binding with Tailscale | Keep as device-binding | discretion | Tailscale IPs are stable per device. IP binding becomes device auth, not anti-replay. Executor may simplify getClientIP() since no X-Forwarded-For needed. |
| 8 | E2E encryption | Retained unchanged | locked | Defense-in-depth over WireGuard. Zero code changes to crypto layer. |
| 9 | TLS termination | `tailscale serve` reverse proxy | locked | Red-team critical: WebAuthn requires secure context (HTTPS). `tailscale serve` auto-provisions Let's Encrypt certs for MagicDNS hostname, proxies to localhost:3456. No Express TLS config needed. |
| 10 | Lock timer scope | Per session token, not per WS | locked | Red-team fix: inactivity timer survives WS disconnect. Prevents reconnect-bypasses-lock race condition. |

## Integration Risks

- **Passkey invalidation**: changing rpID breaks all existing passkeys. Users must re-register via /setup. Mitigated by clear console message on first startup after migration.
- **Tailscale not installed**: server starts but is unreachable from phone. Mitigated by startup check that logs warning if no Tailscale interface detected.
- **xterm.js version pinning**: bundled files won't auto-update. Current version 5.5.0 is stable. Mitigated by documenting update process in update.sh.
- **CSP unsafe-inline for styles**: xterm.js requires inline styles. Cannot use strict style-src. Accepted risk -- inline style injection is lower-severity than script injection.

## Verification Strategy

- [ ] Server accessible via HTTPS on Tailscale MagicDNS hostname from phone, NOT from public internet
- [ ] Browser shows valid certificate (Let's Encrypt via tailscale serve)
- [ ] Create session, lock phone, unlock phone -- session reconnects with scrollback
- [ ] CSP header present on all HTTP responses (check via browser DevTools)
- [ ] After 15 min idle, lock overlay appears; Face ID unlocks; TOTP fallback works
- [ ] E2E encryption handshake completes over Tailscale (check audit log)
- [ ] TOTP login works with new rpID
- [ ] New passkey registration works via /setup with Tailscale hostname
- [ ] xterm.js loads from local vendor/ (no network requests to jsdelivr)
- [ ] Scrollback redaction, attention detection, image upload still work

## Affected Files

| File | Action | Change Description |
|------|--------|--------------------|
| server.js | modify | Remove startTunnel()/ngrok code (~50 lines). Add CSP middleware. Add per-token inactivity tracking + ws.locked flag + lock/unlock protocol. Update rpID/expectedOrigin from config. Simplify getClientIP() (no X-Forwarded-For). Bind localhost only (tailscale serve proxies). Add startup Tailscale check. |
| public/index.html | modify | Replace CDN script/link tags with local vendor/ paths. Add reconnect logic (exponential backoff + session reattach). Add inactivity timer + lock overlay UI. Add passkey re-auth on lock screen. |
| public/vendor/xterm.min.js | create | Bundled xterm.js 5.5.0 |
| public/vendor/xterm.min.css | create | Bundled xterm.js CSS 5.5.0 |
| public/vendor/addon-fit.min.js | create | Bundled xterm.js fit addon 0.10.0 |
| config.json | modify | Remove ngrokDomain. Add tailscaleHostname, inactivityTimeout fields. |
| config.example.json | modify | Template with new fields |
| install.sh | modify | Replace ngrok setup section with Tailscale setup instructions |
| update.sh | modify | Add vendor/ update step, preserve config.json new fields |
| ecosystem.config.js | delete or modify | Remove ngrok process if it exists as separate PM2 entry |
| package.json | modify | No ngrok-related changes needed (ngrok is system binary, not npm dep). Update version. |

## Implementation Sequence

1. **Bundle xterm.js locally** (index.html + vendor/)
   - Dependencies: none
   - Deliverable: xterm.js served from public/vendor/, CDN references removed, app works identically

2. **Remove ngrok, add Tailscale config + HTTPS** (server.js, config.json)
   - Dependencies: step 1
   - Deliverable: startTunnel() deleted, rpID/expectedOrigin from config.tailscaleHostname, getClientIP() simplified, startup Tailscale interface check, `tailscale serve` setup documented and scripted in install.sh. Server binds localhost:3456, `tailscale serve` proxies HTTPS -> localhost.

3. **Add CSP headers** (server.js)
   - Dependencies: step 1 (vendor/ must exist for script-src 'self')
   - Deliverable: CSP middleware on all responses, verified no breakage

4. **Client reconnect + session reattach** (index.html)
   - Dependencies: step 2 (server must be running on Tailscale)
   - Deliverable: WS reconnect with backoff, auto-reattach to previous session, scrollback replay on reconnect

5. **Inactivity lock** (server.js + index.html)
   - Dependencies: step 4 (reconnect must work so lock doesn't kill session)
   - Deliverable: configurable idle timer, lock overlay, Face ID re-auth + TOTP fallback, server-side enforcement

6. **Update install.sh + update.sh** (scripts)
   - Dependencies: steps 1-5
   - Deliverable: Tailscale setup flow in installer, vendor update in updater, passkey re-registration guidance
