---
project: claude-mobile
type: requirements
status: draft
created: 2026-03-18
feature: tailscale-session-security
---

# Requirements: Tailscale Migration + Session Persistence + Security Fixes

## Problem Statement

Claude Mobile tunnels through ngrok, exposing a public URL that anyone on the
internet can probe. The session token appears in /api/config?st= URLs. Terminal
sessions die on WebSocket disconnect (phone lock, network switch). No CSP headers
protect against XSS. No inactivity timeout exists -- a phone left unlocked grants
indefinite access.

## Success Criteria

- [ ] Server is reachable only via Tailscale IP (100.x.y.z) -- no ngrok, no public URL
- [ ] Terminal sessions survive WebSocket disconnect and reconnect with full scrollback
- [ ] CSP headers are set on all HTTP responses from Express
- [ ] After N minutes of inactivity, client locks and requires re-authentication
- [ ] E2E encryption (ECDH + AES-256-GCM) continues to work over Tailscale transport
- [ ] All existing auth flows (TOTP, WebAuthn) work unchanged

## Scope

### In scope

- Remove ngrok tunnel code and dependency from server.js + ecosystem.config.js
- Configure server to bind on 0.0.0.0 (reachable via Tailscale IP) instead of localhost+ngrok
- Tailscale setup documentation (install on Windows + iPhone, join tailnet, MagicDNS)
- Session persistence: keep pty processes alive on WS disconnect, reattach on reconnect
- Replay scrollback buffer to reconnecting client
- Session timeout: configurable max-idle (e.g. 30 min), server-side enforcement
- CSP headers: strict policy on Express (script-src, style-src, connect-src)
- Update config.json schema for Tailscale IP/hostname
- Update install.sh / update.sh for new setup flow

### Out of scope

- tmux integration (Windows incompatible, not needed)
- ngrok fallback mode (Tailscale DERP relays handle most firewall cases)
- Token-in-URL fix (acceptable on private network)
- Mobile app (PWA via Safari/Chrome is sufficient)
- Multi-user support (single-user tool)

## Integration Context

| Component | Relationship |
|-----------|-------------|
| server.js | Remove ngrok spawn, add session persistence logic, add CSP middleware, add inactivity timer |
| public/index.html | Add inactivity lock UI (overlay + re-auth), reconnect logic for session reattach |
| ecosystem.config.js | Remove ngrok process from PM2 config |
| config.json | Replace ngrok fields with Tailscale hostname/IP |
| install.sh | Update for Tailscale setup instructions |
| package.json | Remove ngrok dependency |

## Constraints

- **Stack**: Node.js + Express + node-pty + ws (no new runtime deps for core features)
- **Platform**: Windows 11 (no tmux, no Unix-only tools)
- **Auth**: existing TOTP + WebAuthn + E2E encryption must work unchanged
- **Dependencies**: Tailscale installed separately (not an npm package)
- **Must not break**: scrollback redaction, attention detection, image upload, theme toggle, session management UI

## Simplest Viable Version

Phase 1: Remove ngrok, bind server to 0.0.0.0, document Tailscale setup. Server
already listens on a port -- removing ngrok is subtractive. Phase 2: Session
persistence -- stop destroying pty on WS close, add reattach logic. Phase 3: CSP
headers (one middleware) + inactivity lock (timer + overlay). E2E encryption stays
untouched throughout.

## Open Questions

- Inactivity timeout duration: 15 min, 30 min, or configurable in config.json?
- CSP policy strictness: should xterm.js CDN (jsdelivr) be allowed, or bundle locally?
- IP binding (P0 from previous work): still useful with Tailscale? Tailscale IPs are
  stable per device, so IP binding becomes a device-binding mechanism rather than
  anti-replay.
