# Claude Mobile v3.0.0

Mobile terminal gateway for Claude Code. Access your Claude Code sessions from your iPhone over Tailscale VPN with end-to-end encryption, Face ID authentication, and persistent tmux sessions.

## Quick Install

```bash
git clone https://github.com/Mister-ams/claude-mobile.git
cd claude-mobile
bash install.sh
```

The installer walks you through everything -- prerequisites, Tailscale, WSL/tmux, project config, and TOTP setup.

## Prerequisites

| Prerequisite | Why | Install |
|---|---|---|
| Node.js 18+ | Server runtime | [nodejs.org](https://nodejs.org) |
| Tailscale | VPN tunnel (phone <-> laptop) | `winget install Tailscale.Tailscale` |
| Claude Code CLI | Terminal sessions | `npm i -g @anthropic-ai/claude-code` |
| WSL + Ubuntu 24.04 | tmux host (Windows only) | `wsl --install Ubuntu-24.04` |
| PM2 | Background daemon | `npm i -g pm2` |

Tailscale must be installed on **both** your laptop and iPhone, logged into the same account.

## Update

```bash
bash update.sh
```

Pulls latest, updates deps, restarts PM2. Config and credentials are preserved.

## What It Does

- Spawns Claude Code inside tmux (WSL), streams to your phone via WebSocket
- End-to-end encrypted (ECDH P-256 + AES-256-GCM) -- Tailscale sees double-encrypted blobs
- tmux sessions survive server restarts, PM2 crashes, and laptop reboots (WSL stays running)
- xterm.js terminal with Palantir/Blueprint theme (dark + light mode)
- Slash command autocomplete (discovered from .claude/skills/)
- Touch scroll zones with arrow overlays (left/right when keyboard open)
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

# Restart (tmux sessions survive)
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
  server.js               Express + WS + node-pty + tmux + E2E crypto + auth
  public/index.html        Mobile web UI (xterm.js + Palantir theme)
  public/vendor/           Bundled xterm.js + addons (no CDN)
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
Claude Code -> tmux (WSL) -> node-pty (wsl.exe attach) -> WebSocket -> xterm.js (canvas)
```

- Raw ANSI passthrough from tmux to xterm.js -- no server-side processing
- History restored via `tmux capture-pane -p -e -J -S -10000`
- tmux alternate screen disabled for scroll history access (minor visual artifacts during active rendering)
- Sessions created at phone's column width

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone can't reach server | Check Tailscale is connected on both devices. Run `tailscale status` |
| Stuck on "Connecting securely..." | Delete `.server-identity-key` and restart. Clear site data on phone |
| TOTP code rejected | Check phone clock is synced. Codes are valid for 90 seconds |
| Face ID not offered | Register passkey first: connect via TOTP, accept the passkey prompt |
| Terminal blank after reconnect | tmux session may have exited. Create a new session from the UI |
| iOS keyboard causes jumping | Should not happen on v3+. If so, check viewport meta tag intact |
| Passkeys broken after hostname change | Re-register passkeys (rpID is bound to Tailscale hostname) |
| WSL not starting | Run `wsl --list` to verify Ubuntu-24.04 is installed |

## License

MIT
