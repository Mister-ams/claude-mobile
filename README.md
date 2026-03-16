# Claude Mobile

Mobile terminal gateway for Claude Code. Access your Claude Code sessions from your iPhone with Face ID authentication and a secure tunnel.

## Quick Install

```bash
git clone https://github.com/Mister-ams/claude-mobile.git
cd claude-mobile
bash install.sh
```

The installer handles everything:
1. Checks Node.js, npm, Claude Code CLI
2. Installs dependencies
3. Asks for your project directories
4. Sets up ngrok (permanent URL for phone access)
5. Installs PM2 (background daemon)
6. Starts the server and opens the auth setup page

**Requirements**: Node.js 18+, Claude Code CLI

## What it does

- Spawns Claude Code on your laptop, streams it to your phone via WebSocket
- xterm.js terminal with Palantir/Blueprint dark theme
- Slash command autocomplete (21 commands)
- Touch scroll zones (tap top/bottom half to scroll)
- Multi-session tabs with attention badges
- PM2 daemon (sessions survive terminal close)

## Security

Zero-trust architecture. No tokens or passwords are ever generated or transmitted.

- **Setup**: localhost-only page (physical laptop access required)
- **Primary auth**: Face ID / passkey (WebAuthn, stored in Apple Passwords)
- **Backup auth**: TOTP 6-digit code (Apple Passwords compatible)
- **Session tokens**: 4-hour TTL, auto-expiry
- **Rate limiting**: global + per-IP
- **Env whitelist**: only safe vars passed to terminal
- **Audit log**: all events logged to ~/.claude-mobile-audit.log
- **Scrollback redaction**: API keys, tokens, private keys stripped
- **Input canary**: alerts on dangerous command patterns
- **Auto-shutdown**: 8 hours idle = server stops

## After Install

**Daily use (PM2 running in background):**
```bash
# Check status
pm2 status

# View connection info
pm2 logs claude-mobile --lines 20 --nostream

# Restart (keeps auth, new sessions)
pm2 restart claude-mobile
```

**On your phone:**
- Open `https://your-domain.ngrok-free.dev`
- Tap "Login with Face ID" (after initial TOTP setup)

## Manual Setup (without installer)

```bash
npm install
cp config.example.json config.json
# Edit config.json with your project paths and ngrok domain
node server.js
# Open http://localhost:3456/setup in your laptop browser
```

## Architecture

```
claude-mobile/
  install.sh           Single-file installer (run this)
  server.js            Express + WebSocket + node-pty + ngrok + WebAuthn + TOTP
  public/index.html    Mobile web UI (xterm.js + Palantir/Blueprint theme)
  config.json          Your settings (gitignored, created by installer)
  config.example.json  Template config
  .credentials.json    Passkey store (gitignored, auto-created)
  .totp-secret         TOTP secret (gitignored, auto-created)
```

## License

MIT
