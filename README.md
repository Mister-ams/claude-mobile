# Claude Mobile v3.1.3

Mobile terminal gateway for Claude Code. Access your Claude Code sessions from your iPhone over Tailscale VPN with end-to-end encryption, Face ID authentication, and persistent dtach sessions.

## Quick Install

```bash
git clone https://github.com/Mister-ams/claude-mobile.git
cd claude-mobile
bash install.sh
```

The installer walks you through everything -- prerequisites, Tailscale, WSL/dtach, project config, and TOTP setup.

## Prerequisites

| Prerequisite | Why | Install |
|---|---|---|
| Node.js 18+ | Server runtime | [nodejs.org](https://nodejs.org) |
| Tailscale | VPN tunnel (phone <-> laptop) | `winget install Tailscale.Tailscale` |
| Claude Code CLI | Terminal sessions | `npm i -g @anthropic-ai/claude-code` |
| WSL + Ubuntu 24.04 | dtach host (Windows only) | `wsl --install Ubuntu-24.04` |
| PM2 | Background daemon | `npm i -g pm2` |

Tailscale must be installed on **both** your laptop and iPhone, logged into the same account.

## Update

```bash
bash update.sh
```

Pulls latest, updates deps, restarts PM2. Config and credentials are preserved.

## What It Does

- Spawns Claude Code inside dtach (WSL), streams to your phone via WebSocket
- End-to-end encrypted (ECDH P-256 + AES-256-GCM) -- Tailscale sees double-encrypted blobs
- dtach daemon sessions survive server restarts and PM2 crashes
- Server-side 400KB scrollback buffer replays history on phone reconnect
- GPU-accelerated rendering (WebGL -> Canvas -> DOM fallback chain)
- xterm.js terminal with Palantir/Blueprint theme (dark + light mode)
- Slash command autocomplete (discovered from .claude/skills/)
- Touch scroll zones with arrow overlays (left/right split)
- Keyboard-aware layout: debounced refit for full scroll range, manual scroll
- Multi-session support (up to 8 parallel sessions)
- Attention notifications when Claude needs your input (vibration + red dot)
- Image upload for sharing screenshots with Claude

## Security

### Authentication (4-tier)

| Tier | What | Detail |
|---|---|---|
| P0 | IP-bound sessions | 30-min TTL, auto-rotated via WebSocket. Per-IP + global rate limiting |
| P1 | E2E encryption | Ephemeral ECDH P-256, AES-256-GCM, counter-based nonces, anti-replay |
| P2 | TOFU key pinning | Server P-256 identity key, ECDSA-signed ephemeral keys (SSH-style) |
| P3 | Inactivity lock | Configurable timeout (default 15min), CSP headers, 8h auto-shutdown |

- **Primary auth**: TOTP (Apple Passwords compatible)
- **Secondary auth**: WebAuthn passkeys (Face ID)
- **Setup**: localhost-only `/setup` page (physical laptop access required)

### Defense in Depth

- Rate limiting: global (20 failures = 10min lockout) + per-IP (5 attempts = 60s lockout)
- Env whitelist: only safe variables passed to terminal processes
- Scrollback redaction: API keys, tokens, private keys stripped from replay
- Input canary: alerts on dangerous command patterns
- Audit log: all events logged to `~/.claude-mobile-audit.log`

## Daily Use

```bash
# Start (first time after install)
pm2 start server.js --name claude-mobile && pm2 save

# Status
pm2 status

# Logs
pm2 logs claude-mobile --lines 20 --nostream

# Restart (dtach sessions survive)
pm2 restart claude-mobile
```

**On your iPhone:**
1. Open `https://<your-tailscale-hostname>`
2. First time: verify server fingerprint matches laptop's `/setup` page
3. Tap "Login with Face ID" or enter TOTP code

## Manual Setup (without installer)

```bash
npm install
cp config.example.json config.json
# Edit config.json: add your project paths and Tailscale hostname
tailscale serve --bg http://localhost:3456
node server.js
# Open http://localhost:3456/setup on laptop to configure TOTP
```

## Configuration

Edit `config.json` (created by installer, gitignored):

```json
{
  "port": 3456,
  "tailscaleHostname": "your-machine.tail12345.ts.net",
  "inactivityTimeout": 15,
  "wslDistro": "Ubuntu-24.04",
  "autoStart": ["My Project"],
  "defaultDir": "C:\\Users\\YOU\\Projects\\my-project",
  "projects": [
    { "name": "My Project", "dir": "C:\\Users\\YOU\\Projects\\my-project" }
  ]
}
```

## Architecture

```
claude-mobile/
  server.js               Express + WS + node-pty + dtach + E2E crypto + auth
  public/index.html        Mobile web UI (xterm.js + Palantir theme)
  public/vendor/           Bundled xterm.js + addons (WebGL, Canvas, fit)
  install.sh               Full setup script
  update.sh                Pull + deps + PM2 restart
  config.json              Your settings (gitignored)
  config.example.json      Template config
  .server-identity-key     E2E identity key (gitignored, auto-generated)
  .credentials.json        WebAuthn passkeys (gitignored, auto-created)
  .totp-secret             TOTP secret (gitignored, auto-created)
  .session-meta.json       Session names persistence (gitignored)
```

## Rendering Pipeline

```
Claude Code -> dtach (WSL daemon) -> node-pty (wsl.exe attach) -> WebSocket -> xterm.js (WebGL)
```

- dtach provides pty persistence without terminal emulation overhead
- Raw ANSI passthrough from dtach to xterm.js -- no server-side processing
- Server-side 400KB ring buffer captures all pty output for history replay
- On reconnect: server sends buffer, client uses chunked writes (50-line batches + term.reset)
- GPU-accelerated rendering: WebGL primary, Canvas fallback, DOM last resort
- Sessions created at phone's column width

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone can't reach server | Check Tailscale is connected on both devices. Run `tailscale status` |
| Stuck on "Connecting securely..." | Delete `.server-identity-key` and restart. Clear site data on phone |
| TOTP code rejected | Check phone clock is synced. Codes are valid for 90 seconds |
| Face ID not offered | Register passkey first: connect via TOTP, accept the passkey prompt |
| Terminal blank after reconnect | dtach session may have exited. Create a new session from the UI |
| Keyboard clipping | Should not happen on v3.1+. If so, check viewport meta tag intact |
| Passkeys broken after hostname change | Re-register passkeys (rpID is bound to Tailscale hostname) |
| WSL not starting | Run `wsl --list` to verify Ubuntu-24.04 is installed |
| Sessions lost on restart | Check `wsl -d Ubuntu-24.04 -u root -- ls /tmp/cm-*.dtach` for sockets |

## Changelog

### v3.1.3 (2026-03-23)
- **dtach migration**: replaced tmux with dtach for session persistence
- **Daemon mode**: dtach -n creates daemon sessions that survive PM2 restarts
- **Server-side history**: 400KB ring buffer replays on reconnect (no history loss)
- **Chunked scrollback**: 50-line batched writes prevent xterm.js parser corruption
- **Keyboard fix**: debounced fit() after animation, manual scroll, no clipping
- **Cleanup**: removed diagnostic logging, streamlined installer for dtach

### v3.0.2 (2026-03-22)
- GPU-accelerated rendering (WebGL -> Canvas -> DOM fallback)

### v3.0.1 (2026-03-22)
- Slash command discovery (skills/ + commands/ directories)
- Scroll and keyboard stability fixes

### v3.0.0 (2026-03-20)
- Installer overhaul (4-phase, platform detection)
- Safari-style swipe navigation between sessions
- README rewrite

## License

MIT
