# CLAUDE.md -- Project OTG (On-The-Go)

Claude Mobile Bridge -- mobile web interface for Claude Code terminal sessions over Tailscale VPN.

## Architecture

```
claude-mobile/                    v3.2.1
├── server.js                     Node.js: Express + WebSocket + node-pty + dtach (WSL) + E2E crypto
├── config.json                   Projects, autoStart, tailscaleHostname, port (gitignored)
├── config.example.json           Template for config.json
├── install.sh                    Full setup script (WSL, dtach, PM2, Tailscale serve)
├── update.sh                     Pull + deps + PM2 restart
├── public/
│   ├── index.html                Mobile web UI (xterm.js, custom input, Palantir theme, merged #auth-screen)
│   ├── setup.html                Setup pages (TOTP config, extracted from server.js in T08)
│   ├── style.css                 Extracted CSS (503 lines) -- layout, themes, animations
│   ├── vendor/                   Bundled xterm.js + addons (no CDN)
│   └── apple-touch-icon.png      PWA icon
├── package.json                  Deps: express, ws, node-pty, @simplewebauthn/server, otpauth, qrcode
└── .gitignore                    node_modules/, config.json, .totp-secret, .credentials.json, .server-identity-key
```

## How it works

- Claude Code runs inside dtach (WSL Ubuntu-24.04) for session persistence across server restarts
- dtach detaches/reattaches pty sessions without terminal emulation -- xterm.js gets raw pty output
- node-pty spawns `wsl.exe` to attach to dtach sessions; raw ANSI streams over WebSocket to xterm.js
- Server-side 400KB ring buffer (`session.scrollback`) captures all pty output for history replay
- On reconnect, server sends buffer to client; client uses `term.reset()` + chunked writes (50 lines/batch)
- Tailscale VPN provides zero-public-surface networking; `tailscale serve` proxies HTTPS -> localhost:3456
- PM2 manages the daemon; dtach sessions survive PM2/node restarts (live in WSL as socket files)
- Attention detection (5s debounce) triggers Web Notifications + vibration on permission prompts, questions, idle prompt
- GPU-accelerated rendering: WebGL -> Canvas -> DOM fallback chain (v3.0.2)
- Slash command discovery: scans skills/ + commands/ directories (v3.0.1)

## Security (4-tier)

- **P0**: IP-bound session tokens (30-min TTL, auto-rotated via WebSocket). Per-IP + global rate limiting.
- **P1**: Ephemeral ECDH P-256 + AES-256-GCM per WebSocket. Counter-based IV. Anti-downgrade enforcement.
- **P2**: TOFU key pinning -- server P-256 identity key, ECDSA signature binding ephemeral keys.
- **P3**: CSP headers + configurable inactivity lock (default 15min). 8h auto-shutdown.
- Auth: TOTP (Apple Passwords) primary, WebAuthn passkeys (Face ID) secondary. Setup via localhost-only `/setup` page.
- WebAuthn rpID = `config.json` tailscaleHostname (Tailscale MagicDNS hostname).

## Key decisions

- xterm.js `disableStdin: true` -- all input via textarea, avoids iOS keyboard bugs
- `interactive-widget=resizes-content` in viewport meta -- iOS manages keyboard natively, no JS height management
- Terminal refits on WIDTH change only (orientation). Height changes: zero JS interaction with xterm.js
- dtach for process persistence -- no terminal emulation layer, no alternate screen issues
- `session.scrollback` (400KB ring buffer) replaces tmux capture-pane for history replay
- Chunked scrollback writes (50-line batches via term.write callback) prevent xterm.js parser corruption
- Claude launched via `cmd.exe /c claude` (Windows interop from WSL) -- uses existing Windows auth
- Sessions created at phone's column width (client sends cols/rows on create)
- No bracketed paste -- Claude Code TUI ignores \r after paste sequences; send plain text + \r
- Image upload via zero-size absolute file input (not display:none) for iOS compatibility

## Launch

```bash
pm2 start server.js --name claude-mobile    # start daemon
pm2 logs claude-mobile                       # view logs
bash update.sh                               # pull + restart
```

Setup: open `http://localhost:3456/setup` on laptop to configure TOTP.

## Gotchas

- No JS should change `appEl.style.height` or call `scrollToBottom` on resize events
- `doResize()` must check `proposeDimensions()` before `fit()` -- skip if cols/rows unchanged
- WSL Ubuntu-24.04 must be running for dtach sessions to work
- dtach sessions use socket files at `/tmp/cm-{id}.dtach` -- do not manually create with that prefix
- After PM2 restart, scrollback buffer starts empty and rebuilds from live output
- `.session-meta.json` persists session names across restarts
- config.json is gitignored; config.example.json is the template
- Port 3456 must be free (PM2 manages lifecycle; `pm2 stop claude-mobile` to free it)
- Passkeys must be re-registered if tailscaleHostname changes (rpID binding)
- Text and Enter must be sent as single atomic pty write (qsend(t + '\r')) -- separate writes race in the pipeline

## Current State

v3.2.1 (head: f8b950d). Full code review (4-agent, 38 findings) + v3.1.6 fixes + hotfix v3.1.7 + re-review (10 fixes) + architecture cleanup complete.
Key changes: async createSession (event-loop fix), E2E crypto hardening, 28 empty catches replaced with audit logging, CSS extracted to public/style.css (503 lines), client `sessions` renamed to `sessionList`, auth responses normalized (verified->success), dep update (path-to-regexp GHSA-37ch-88jc-xwx2). T07: login/lock merged into single #auth-screen. T08: setup pages extracted to public/setup.html + /api/setup/status endpoint. server.js 1836->1769 LOC.
iOS gotchas discovered: confirm() dialog blocks JS killing WS 2.4s after auth; strict sequential client replay check breaks iOS Safari (reverted to gap-tolerant <=).
Active track in `.planning/`:
- **v4-thin-viewer**: thin viewer architecture (blocked -- tech-design references tmux but stack uses dtach since v3.1.3; reconciliation needed before Wave 0)
Completed (archived): scrollback-and-dtach, v3.1.3-hardening, v3.1.4-should-fix.
