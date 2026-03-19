# Claude Mobile Resilience Setup

**Date:** 2026-03-19
**Status:** Draft
**Scope:** WSL+tmux session persistence, Windows service auto-start, health watchdog with Telegram alerts

## Problem

Claude Mobile runs on a Windows 11 laptop (16GB RAM) with three gaps:

1. **No session persistence** — WSL is not installed, so the server runs in direct pty mode. PM2 has restarted 17 times, each restart killing the active Claude conversation.
2. **No boot-level auto-start** — `pm2 startup` doesn't work on Windows. After reboot, the user must manually start the process.
3. **No failure awareness** — when the server dies or hangs, the user (on their iPhone, away from the laptop) sees a connection timeout with no information about what went wrong.

## Design

### Layer 1: WSL + tmux for Session Persistence

**Goal:** Claude sessions survive PM2 restarts and server crashes.

**How it works today (in the code, but not on this machine):**
- `server.js` spawns `wsl.exe -d Ubuntu-24.04 -- tmux attach-session -t cm-{id}`
- Claude runs via `cmd.exe /c claude` inside the tmux session (Windows interop)
- tmux sessions live in WSL — they survive Node/PM2 restarts
- History restored via `tmux capture-pane -p -e -J -S -10000`

**What we install:**
1. Create `~/.wslconfig`:
   ```ini
   [wsl2]
   memory=1GB
   swap=0
   ```
2. Install WSL Ubuntu-24.04: `wsl --install Ubuntu-24.04 --no-launch`
3. Inside WSL: install **only tmux** (`apt install tmux`). No Node, PM2, or Claude CLI inside WSL — they run on Windows.
4. Restart WSL to pick up memory config: `wsl --shutdown`

**RAM impact:** ~400-600MB for WSL idle. With 1GB cap, it cannot spiral. Current free RAM is ~4GB, leaving ~3.4GB after WSL.

**server.js changes:** None. The code already has full WSL+tmux support. Once WSL is installed, it automatically uses tmux sessions.

**Known limitation:** If WSL2 itself crashes (occasional Windows 11 issue), tmux sessions inside it are lost. The health watchdog detects this and restarts, but the conversation is gone. This is an unavoidable WSL limitation.

### Layer 2: Windows Service + PM2 for Auto-Start

**Goal:** Claude Mobile starts at boot, before user login.

**Architecture:**
```
Windows Service (node-windows: "ClaudeMobile")
  └── runs: pm2 resurrect
        └── manages: claude-mobile (server.js)
```

**Why both:**
- `node-windows` does one job: start PM2 at boot (before login)
- PM2 does everything else: crash restart, `pm2 logs`, `pm2 monit`, graceful restart

**Implementation:**
1. Add `node-windows` as a dev dependency
2. Create `service-install.js`:
   - Service name: `ClaudeMobile`
   - Executes: `pm2 resurrect` (restores saved process list)
   - Runs as SYSTEM account
3. Create `service-uninstall.js` for clean removal
4. PM2 configured with `--max-memory-restart 500M` to catch memory leaks

**Workflow preserved:**
- `pm2 logs claude-mobile` — unchanged
- `pm2 restart claude-mobile` — unchanged
- `pm2 monit` — unchanged
- `bash update.sh` — unchanged (already uses `pm2 restart`)

### Layer 3: Health Watchdog with Telegram Alerts

**Goal:** Detect failures (including hung processes) and alert the user remotely.

#### 3a. Health Endpoint

Add `GET /health` to `server.js`:
```json
{
  "status": "ok",
  "uptime": 3600,
  "sessions": 2,
  "wsl": true,
  "memory": { "rss": 85, "heap": 52 },
  "lastError": null
}
```

- `wsl` field: checks `wsl -d Ubuntu-24.04 -- echo 1` (cached, refreshed every 30s to avoid overhead)
- `memory` field: `process.memoryUsage()` in MB
- `lastError`: last error message and timestamp, reset on successful health check
- No authentication required (localhost only — Tailscale serve doesn't expose this path, and the endpoint returns no sensitive data)

#### 3b. Startup Audit Line

Add to server.js startup logging:
```
Server started | restart_count: N | last_shutdown: {reason} | wsl: {true/false}
```
Correlates with PM2 logs for post-incident review.

#### 3c. Scheduled Task Watchdog

Windows Scheduled Task that runs every 5 minutes:

1. `curl http://localhost:3456/health`
2. On failure (timeout or non-200 or `"wsl": false`):
   - `pm2 restart claude-mobile`
   - Send Telegram alert: `"⚠️ Claude Mobile restarted — reason: {detail}"`
3. On restart failure:
   - Send Telegram alert: `"🔴 Claude Mobile DOWN — manual intervention needed"`
4. On success after previous failure:
   - Send Telegram alert: `"✅ Claude Mobile recovered"`

**Telegram integration:**
- Direct API call to `api.telegram.org/bot{TOKEN}/sendMessage`
- Bot token stored in `.telegram-token` (gitignored, alongside `.totp-secret`)
- Chat ID: `496270209` (hardcoded in watchdog script, same as existing bot)
- No dependency on Railway bot — works even if Railway is down

**Implementation:** PowerShell script (`watchdog.ps1`) registered as a Windows Scheduled Task via `schtasks`.

## Files Changed/Created

| File | Action | Description |
|------|--------|-------------|
| `server.js` | Edit | Add `/health` endpoint, startup audit line |
| `package.json` | Edit | Add `node-windows` dev dependency |
| `service-install.js` | Create | One-time Windows service registration |
| `service-uninstall.js` | Create | Clean service removal |
| `watchdog.ps1` | Create | Health check + Telegram alert script |
| `install.sh` | Edit | Update Step 5: trim WSL packages to tmux-only, add `.wslconfig`, add service + watchdog setup |
| `update.sh` | Edit | Add WSL health check after restart |
| `.gitignore` | Edit | Add `.telegram-token` |
| `~/.wslconfig` | Create | WSL2 memory cap (1GB, no swap) |

## What We Don't Change

- `config.json` format — no breaking changes
- `public/index.html` — no UI changes
- Authentication flow — unchanged
- WebSocket protocol — unchanged
- tmux session naming (`cm-{id}`) — unchanged

## Failure Mode Coverage

| Failure | Detection | Recovery | Alert |
|---------|-----------|----------|-------|
| Server crash (process exit) | PM2 | PM2 auto-restart | Telegram (if health check was failing) |
| Server hang (unresponsive) | Scheduled task `/health` timeout | `pm2 restart` | Telegram |
| Memory leak | PM2 `--max-memory-restart 500M` | PM2 auto-restart | Telegram |
| WSL crash | `/health` returns `"wsl": false` | `pm2 restart` (re-checks WSL on startup) | Telegram |
| Machine reboot | N/A | Windows service → `pm2 resurrect` | None needed |
| WSL session loss | Unavoidable | New session created on next use | None (no way to detect lost tmux session vs. intentional close) |

## Desktop Migration Path

All setup is captured in `install.sh`. On the new desktop:
1. `git clone` the repo
2. `bash install.sh` — handles WSL, tmux, Tailscale, service, watchdog
3. Copy `.telegram-token`, `.totp-secret`, `.credentials.json`, `config.json` from laptop
4. Re-register Face ID passkeys (rpID changes with new Tailscale hostname)

## Success Criteria

1. Claude conversations survive PM2 restarts (tmux persistence)
2. Server starts automatically after reboot without user login
3. Hung/crashed server recovers within 5 minutes
4. User receives Telegram notification on failure with actionable reason
5. WSL stays under 1GB RAM
