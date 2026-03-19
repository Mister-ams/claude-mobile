# CLAUDE.md -- Project OTG (On-The-Go)

Claude Mobile Bridge -- mobile web interface for Claude Code terminal sessions over Tailscale VPN.

## Architecture

```
claude-mobile/                    v3.0.0
├── server.js                     Node.js: Express + WebSocket + node-pty + tmux (WSL) + E2E crypto
├── config.json                   Projects, autoStart, tailscaleHostname, port (gitignored)
├── config.example.json           Template for config.json
├── install.sh                    Full setup script (WSL, tmux, PM2, Tailscale serve)
├── update.sh                     Pull + deps + PM2 restart
├── public/
│   ├── index.html                Self-contained mobile web UI (xterm.js, custom input, Palantir theme)
│   ├── vendor/                   Bundled xterm.js + addons (no CDN)
│   └── apple-touch-icon.png      PWA icon
├── package.json                  Deps: express, ws, node-pty, @simplewebauthn/server, otpauth, qrcode
└── .gitignore                    node_modules/, config.json, .totp-secret, .credentials.json, .server-identity-key
```

## How it works

- Claude Code runs inside tmux (WSL Ubuntu-24.04) for session persistence across server restarts
- node-pty spawns `wsl.exe` to attach to tmux sessions; raw ANSI streams over WebSocket to xterm.js
- History restored via `tmux capture-pane -p -e -J -S -10000` (rendered text + colors, joined lines)
- Raw scrollback buffer MUST NOT be sent to client -- replays old TUI cursor positioning, corrupts display
- Tailscale VPN provides zero-public-surface networking; `tailscale serve` proxies HTTPS -> localhost:3456
- PM2 manages the daemon; tmux sessions survive PM2/node restarts (live in WSL)
- Attention detection (5s debounce) triggers Web Notifications + vibration on permission prompts, questions, idle prompt

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
- tmux alternate screen disabled (`smcup@:rmcup@` + `alternate-screen off`) for scroll history access
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

- NEVER send raw `session.scrollback` to client -- use `tmux capture-pane` for history
- No JS should change `appEl.style.height` or call `scrollToBottom` on resize events
- `doResize()` must check `proposeDimensions()` before `fit()` -- skip if cols/rows unchanged
- Dots appear during active Claude Code work (alternate screen off trade-off) -- settles when done
- WSL Ubuntu-24.04 must be running for tmux sessions to work
- tmux sessions named `cm-{id}` -- do not manually create with that prefix
- `.session-meta.json` persists session names across restarts
- config.json is gitignored; config.example.json is the template
- Port 3456 must be free (PM2 manages lifecycle; `pm2 stop claude-mobile` to free it)
- Passkeys must be re-registered if tailscaleHostname changes (rpID binding)
