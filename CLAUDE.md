# CLAUDE.md -- Project OTG (On-The-Go)

Claude Mobile Bridge -- mobile web interface for Claude Code terminal sessions over Tailscale VPN.

## Architecture

```
claude-mobile/                    v3.2.18
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

## Renderer

Default is the cell-grid renderer (W6 T24 cutover at 3.2.18, 2026-05-04). Server-side `@xterm/headless` v6.0.0 mirror diffs against last-emitted state; ships row changes (RLE-collapsed `CellRun[]`) over WS as `snapshot` (full state) and `frame` (changed rows). Client (`gridTerms{}`) maintains a virtualized DOM with bounded mount window via spacers. Cursor renders as a 2px absolute-positioned bar tracked from snapshot/frame `cursor` field.

Legacy xterm.js path retained as **opt-out fallback**: `?renderer=xterm` in URL forces it. Used by clients hitting any unforeseen grid-mode issue. T26-T28 (delete legacy server scrollback handler, drop xterm.js vendor bundle, sweep this file) are intentionally held to keep the fallback shipped.

Per-WS `gridRenderer` flag set from the `connect` message's `renderer` field (`server.js:1638`). All four client-side `connect` senders MUST include `renderer: RENDERER_MODE` -- missing it bricks history rendering on the affected WS. See `memory/project_w6_history_render_bug.md`.

## Current State

v3.2.18 (head: 8b3baf2). Render-pipeline initiative CLOSED 2026-05-04: 18 patch releases across W1-W7. Grid is default; xterm fallback retained. [verified -- git log + pm2 list]

Pointers: `HANDOVER.md` (current state + decisions), `.planning/STATE-render-pipeline.yaml` (canonical per-wave commits + retrospective), `memory/project_w6_history_render_bug.md` (post-mortem of the cutover bug), `guide-tui-rendering-references.md` (OpenTUI + CLI rendering analysis).
Completed (archived): scrollback-and-dtach, v3.1.3-hardening, v3.1.4-should-fix, v3.1.6-review-fixes, architecture-cleanup, audit-v3.1.3-review, render-pipeline (W1-W7).
