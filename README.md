# Claude Mobile

Mobile web interface for Claude Code terminal sessions. Access your Claude Code from your iPhone via Face ID authentication and a secure tunnel.

## What it does

- Spawns Claude Code sessions on your laptop, streams them to your phone via WebSocket
- xterm.js terminal rendering with touch scroll zones
- Slash command autocomplete (21 commands)
- Multi-session tabs with attention badges
- PM2 background daemon (sessions survive terminal close)

## Security

- **Zero-trust auth**: TOTP setup via localhost-only page (requires physical laptop access)
- **Face ID / Passkey**: WebAuthn primary auth (stored in Apple Passwords)
- **TOTP backup**: 6-digit verification code (Apple Passwords compatible)
- **No tokens or passwords**: Bootstrap token never generated
- **Session tokens**: 4-hour TTL with auto-expiry
- **Rate limiting**: Global (20 failures = 10 min lockout) + per-IP
- **Env whitelist**: Only safe vars passed to terminal processes
- **Audit log**: All auth events, session actions logged to ~/.claude-mobile-audit.log
- **Scrollback redaction**: API keys, tokens, private keys stripped
- **Input canary**: Alerts on dangerous command patterns
- **Auto-shutdown**: 8 hours idle = server stops

## Prerequisites

- Node.js 18+
- Claude Code CLI installed and in PATH
- ngrok account (free) with a static domain
- PM2 (optional, for background daemon)

## Install

```bash
git clone https://github.com/Mister-ams/claude-mobile.git
cd claude-mobile
npm install
```

## Configure

```bash
# Copy and edit the config
cp config.example.json config.json
```

Edit `config.json`:
- `ngrokDomain`: your free ngrok static domain (get one at dashboard.ngrok.com > Domains)
- `projects`: your project directories (Claude Code will open in these)
- `autoStart`: which projects to auto-launch on server start

Set up ngrok:
```bash
# Install ngrok
winget install ngrok.ngrok    # Windows
brew install ngrok             # macOS

# Authenticate (one-time)
ngrok config add-authtoken YOUR_AUTH_TOKEN
```

## First-time setup

```bash
# Start the server
node server.js

# Open the setup page in your laptop browser
# http://localhost:3456/setup
```

The setup page (localhost only) will:
1. Generate a TOTP secret and display a QR code
2. Scan the QR with your iPhone camera -- Apple Passwords saves the verification code
3. Enter the 6-digit code to verify

After setup, open the tunnel URL on your phone:
1. Enter the TOTP code from Apple Passwords
2. You'll be prompted to register a passkey (Face ID)
3. Future logins: just tap "Login with Face ID"

## Run with PM2 (recommended)

```bash
npm install -g pm2
pm2 start server.js --name claude-mobile
pm2 save
```

Commands:
```bash
pm2 logs claude-mobile     # view logs
pm2 restart claude-mobile  # restart (keeps auth, kills sessions)
pm2 stop claude-mobile     # stop
pm2 status                 # check status
```

## Run manually

```bash
node server.js
```

## Windows Firewall (LAN access)

If you want local network access (same WiFi), run as admin:
```powershell
New-NetFirewallRule -DisplayName 'Claude Mobile' -Direction Inbound -Protocol TCP -LocalPort 3456 -Action Allow -Profile Private
```

## Architecture

```
claude-mobile/
  server.js          Express + WebSocket + node-pty + ngrok + WebAuthn + TOTP
  public/
    index.html       Mobile web UI (xterm.js + Palantir/Blueprint theme)
  config.json        Your projects and settings (gitignored)
  config.example.json  Template config
  .credentials.json  Passkey credentials (gitignored, auto-created)
  .totp-secret       TOTP shared secret (gitignored, auto-created)
```

## License

MIT
