# CLAUDE.md — Project OTG (On-The-Go)

Claude Mobile Bridge -- mobile web interface for Claude Code terminal sessions.

## Architecture

```
claude-mobile/
├── server.js          Node.js server: Express + WebSocket + node-pty + cloudflared tunnel
├── config.json        Project dirs, autoStart list, port
├── public/
│   └── index.html     Self-contained mobile web UI (xterm.js display, custom input)
├── package.json       Deps: express, ws, node-pty, qrcode-terminal
└── .gitignore         node_modules/, .pin
```

## How it works

- Server spawns Claude Code in node-pty, streams I/O over WebSocket
- Client uses xterm.js for terminal rendering (display-only, disableStdin)
- Dedicated textarea + Send/Enter button for input
- Touch scroll zones (tap top/bottom half of terminal) replace native scroll
- Cloudflare tunnel auto-starts for remote access (any network)
- PIN auth regenerates every server start
- Auto-starts sessions from config.json `autoStart` array

## Key decisions

- xterm.js `disableStdin: true` -- all input via textarea, avoids iOS keyboard bugs
- No bracketed paste -- Claude Code's TUI ignores \r after paste sequences; send plain text + \r
- Touch scrolling disabled on xterm viewport -- replaced with tap zones + scrollLines() API
- Clear prompt uses End key + 200x backspace (Claude Code TUI doesn't support Ctrl+U)
- PIN not persisted -- fresh 6-digit code each server start for security

## Launch

From Moonwalk Launcher: press `M`
Or manually: `cd ~/Projects/claude-mobile && node server.js`

## Gotchas

- Port 3456 must be free (kill old server first)
- Windows Firewall rule needed for LAN access: `New-NetFirewallRule -DisplayName 'Claude Mobile Bridge' -Direction Inbound -Protocol TCP -LocalPort 3456 -Action Allow -Profile Private`
- cloudflared installed at `C:\Program Files (x86)\cloudflared\cloudflared.exe`
- Tunnel URL changes every restart -- scan QR code from server console
- iPhone Personal Hotspot blocks inbound connections -- use tunnel URL, not LAN IP
