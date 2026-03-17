# Claude Mobile

Mobile terminal gateway for Claude Code. Access your Claude Code sessions from your iPhone with end-to-end encryption, Face ID authentication, and a permanent tunnel URL.

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

**Requirements**: Node.js 18+, Claude Code CLI, ngrok account (free tier works)

## Update

```bash
cd claude-mobile
bash update.sh
```

Pulls latest code, updates dependencies if needed, restarts PM2. All your credentials and config are preserved.

## What It Does

- Spawns Claude Code on your laptop, streams it to your phone via WebSocket
- End-to-end encrypted (ECDH + AES-256-GCM) -- your tunnel provider cannot read traffic
- xterm.js terminal with Palantir/Blueprint theme (dark + light mode)
- Slash command autocomplete (37 commands)
- Touch scroll zones (tap top/bottom half to scroll)
- Multi-session support (up to 8 parallel sessions)
- Pull-up gesture on session counter to create new sessions
- Attention notifications when Claude needs your input
- PM2 daemon (sessions survive terminal close)

## Security

Three-tier transport security with zero-trust authentication.

### Authentication
- **Setup**: localhost-only page (physical laptop access required)
- **Primary auth**: Face ID / passkey (WebAuthn)
- **Backup auth**: TOTP 6-digit code (Apple Passwords compatible)
- **Session tokens**: 30-min TTL, IP-bound, auto-rotating

### Encryption (P0-P2)
- **P0 -- IP binding**: tokens are locked to the IP that created them
- **P1 -- E2E encryption**: ephemeral ECDH P-256 key exchange per connection, AES-256-GCM with counter-based nonces, replay protection via monotonic sequence numbers
- **P2 -- TOFU pinning**: server identity key verified on first connection (SSH-style trust-on-first-use), signed ephemeral keys prevent MITM
- **Anti-downgrade**: plaintext messages rejected after handshake, 10s encryption timeout

### Defense in Depth
- Rate limiting: global (20 failures = 10min lockout) + per-IP (5 attempts = 60s lockout)
- Env whitelist: only safe variables passed to terminal processes
- Scrollback redaction: API keys, tokens, private keys stripped from replay
- Input canary: alerts on dangerous command patterns (rm -rf, eval, etc.)
- Auto-shutdown: 8 hours idle = server stops
- Audit log: all events logged to `~/.claude-mobile-audit.log`

### What Your Tunnel Provider Sees

After the E2E handshake, all WebSocket frames are opaque encrypted blobs:
```json
{"e":"base64url_encrypted_data...","n":42}
```
They cannot read terminal output, inject commands, or steal session tokens.

## After Install

**Daily use (PM2 running in background):**
```bash
# Check status
pm2 status

# View connection info + server fingerprint
pm2 logs claude-mobile --lines 20 --nostream

# Restart (keeps auth, clears sessions)
pm2 restart claude-mobile
```

**On your phone:**
1. Open `https://your-domain.ngrok-free.dev`
2. First time: verify the server fingerprint matches your laptop's `/setup` page
3. Tap "Login with Face ID" or enter TOTP code

## Manual Setup (without installer)

```bash
npm install
cp config.example.json config.json
# Edit config.json: add your project paths and ngrok domain
node server.js
# Open http://localhost:3456/setup in your laptop browser
# Scan the QR code with Apple Passwords to set up TOTP
```

## Configuration

Edit `config.json` (created by installer, gitignored):

```json
{
  "port": 3456,
  "ngrokDomain": "your-domain.ngrok-free.dev",
  "projects": [
    { "name": "My Project", "dir": "/path/to/project" }
  ],
  "autoStart": ["My Project"]
}
```

## Architecture

```
claude-mobile/
  install.sh              Single-file installer
  update.sh               Pull latest + restart
  server.js               Express + WS + node-pty + E2E crypto + auth
  public/index.html       Mobile web UI (xterm.js + Blueprint theme)
  config.json             Your settings (gitignored)
  config.example.json     Template config
  .server-identity-key    E2E identity key (gitignored, auto-generated)
  .credentials.json       WebAuthn passkeys (gitignored, auto-created)
  .totp-secret            TOTP secret (gitignored, auto-created)
  .planning/              Security design docs (requirements, tech-design, audit)
```

## UI Features

- **Theme**: Palantir/Blueprint design system with dark and light modes
- **Colorblind-safe**: status indicators use shape + color (not color alone)
- **Touch targets**: 44px minimum (Apple HIG compliant)
- **Keyboard-aware**: terminal refits when iOS keyboard opens/closes
- **Session management**: pull-up gesture on counter creates new sessions
- **Uppercase session names**: all session names are displayed in uppercase

## Troubleshooting

| Problem | Fix |
|---------|-----|
| ngrok ERR_NGROK_3200 (offline) | Server not running. Start with `pm2 start` or `node server.js` |
| Stuck on "Connecting securely..." | Delete `.server-identity-key` and restart. Clear site data on phone. |
| iOS keyboard causes jumping | Update to latest (font-size 16px fix prevents iOS auto-zoom) |
| TOTP code rejected | Check phone clock is synced. Codes are valid for 90 seconds. |
| Face ID not offered | Register passkey first: connect via TOTP, accept the passkey prompt |

## License

MIT
