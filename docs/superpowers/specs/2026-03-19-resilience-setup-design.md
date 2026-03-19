# Claude Mobile Resilience Setup

**Date:** 2026-03-19
**Status:** Draft
**Scope:** WSL+tmux session persistence, auto-start via Task Scheduler, health watchdog with Telegram alerts

## Problem

Claude Mobile runs on a Windows 11 laptop (16GB RAM) with three gaps:

1. **No session persistence** — WSL is not installed, so the server runs in direct pty mode. PM2 has restarted 17 times, each restart killing the active Claude conversation.
2. **No auto-start** — `pm2 startup` doesn't work on Windows. After reboot, the user must manually start the process.
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
   swap=256MB
   ```
   Swap set to 256MB as a safety valve — prevents OOM-killer from terminating tmux if WSL memory briefly spikes.
2. Install WSL Ubuntu-24.04: `wsl --install Ubuntu-24.04 --no-launch`
3. Inside WSL: install **only tmux** (`apt install tmux`). No Node, PM2, or Claude CLI inside WSL — they run on Windows. The existing `install.sh` Step 5 (lines 166-181) currently installs Node, PM2, and Claude inside WSL — these must be **removed** from the script.
4. Restart WSL to pick up memory config: `wsl --shutdown`

**RAM impact:** ~400-600MB for WSL idle. With 1GB cap + 256MB swap, it cannot spiral. Current free RAM is ~4GB, leaving ~3.4GB after WSL.

**server.js changes:** Add WSL availability check with graceful fallback. The current code always calls `createTmuxSession()` → `attachToTmux()` with no fallback. With Task Scheduler on login, WSL should be available immediately, but as a safety net:
1. Check WSL availability on startup: `wsl -d Ubuntu-24.04 -- echo 1`
2. If WSL unavailable, retry every 5 seconds for up to 30 seconds (WSL should be ready quickly after login)
3. If WSL still unavailable after retries, log error and start in degraded mode (direct pty, no tmux) — new sessions still work but without persistence
4. Periodically re-check WSL availability (every 30s) and switch to tmux mode once WSL comes online
5. Set a global `wslAvailable` flag that the `/health` endpoint reads

**Known limitation:** If WSL2 itself crashes (occasional Windows 11 issue), tmux sessions inside it are lost. The health watchdog detects this and restarts, but the conversation is gone. This is an unavoidable WSL limitation.

### Layer 2: Task Scheduler + PM2 for Auto-Start

**Goal:** Claude Mobile starts automatically when the user logs in.

**Why on-login, not at-boot:** WSL2 is tied to the user session — `wsl.exe` won't work until the `abdul` user is logged in. A boot-level Windows service (e.g., `node-windows`) would start server.js before WSL is available, forcing it into degraded direct-pty mode until login anyway. Task Scheduler on login gives the same result with zero extra dependencies.

**Architecture:**
```
Task Scheduler (trigger: user login)
  └── runs: pm2 resurrect
        └── manages: claude-mobile (server.js)
```

**Implementation:**
1. Register a scheduled task via `schtasks`:
   ```
   schtasks /Create /TN "ClaudeMobile" /TR "pm2 resurrect" /SC ONLOGON /RL HIGHEST
   ```
   - Runs as current user (inherits PATH, PM2_HOME, WSL access)
   - `/RL HIGHEST` — run with highest privileges (needed for WSL access)
   - No extra dependencies, no service registration scripts
2. PM2 configured with `--max-memory-restart 750M` to catch memory leaks (500M is too aggressive — normal operation with multiple sessions and scrollback buffers can reach 500M)
3. `install.sh` adds this task automatically; `schtasks /Delete /TN "ClaudeMobile" /F` to remove

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
- `lastError`: last error message and timestamp, persists for 1 hour after the error occurred (not cleared on next health check call — ensures errors are visible during manual inspection, not just during the 5-minute watchdog window)
- **Localhost-only binding**: the endpoint checks `req.ip` and only responds to `127.0.0.1`/`::1`. Tailscale serve proxies all paths to localhost, so without this guard `/health` would be accessible at `https://ad-lap-7.tailfe2601.ts.net/health`, leaking session count, memory usage, and error details to anyone on the Tailnet.

#### 3b. Startup Audit Line

Add to server.js startup logging:
```
Server started | restart_count: N | wsl: {true/false}
```
Correlates with PM2 logs for post-incident review. Shutdown reason is already captured by PM2 logs (`pm2 logs claude-mobile`), so duplicating it here adds complexity without value.

#### 3c. Scheduled Task Watchdog

Windows Scheduled Task that runs every 5 minutes:

1. `curl.exe http://localhost:3456/health` (uses Windows 11 built-in `curl.exe`, not PowerShell's `Invoke-WebRequest` alias — predictable timeout and exit code behavior)
2. On **2 consecutive failures** (avoids false positives from transient load spikes):
   - If `"wsl": false`: attempt `wsl --shutdown` then `wsl -d Ubuntu-24.04 -- echo 1` before restarting PM2
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
| `server.js` | Edit | Add `/health` endpoint (localhost-only), startup audit line, WSL availability check with retry + degraded mode fallback |
| `package.json` | Edit | No new dependencies needed |
| `watchdog.ps1` | Create | Health check + Telegram alert script |
| `install.sh` | Edit | Update Step 5: trim WSL packages to tmux-only, add `.wslconfig`, add Task Scheduler registration + watchdog setup |
| `update.sh` | Edit | Add WSL health check after restart |
| `.gitignore` | Edit | Add `.telegram-token` |
| `~/.wslconfig` | Create | WSL2 memory cap (1GB, 256MB swap) |

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
| Memory leak | PM2 `--max-memory-restart 750M` | PM2 auto-restart | Telegram |
| WSL crash | `/health` returns `"wsl": false` | Watchdog restarts WSL (`wsl --shutdown` + re-init), then `pm2 restart` | Telegram |
| WSL not ready at boot | server.js startup retry loop (5s x 12) | Starts in degraded direct-pty mode, auto-upgrades to tmux when WSL comes online | Logged |
| Machine reboot | N/A | Task Scheduler on login → `pm2 resurrect` | None needed |
| WSL session loss | Unavoidable | New session created on next use | None (no way to detect lost tmux session vs. intentional close) |

## Rollback Plan

If WSL causes instability or other issues:
1. `schtasks /Delete /TN "ClaudeMobile" /F` — removes auto-start task
2. `schtasks /Delete /TN "ClaudeMobileWatchdog" /F` — removes watchdog task
3. `wsl --unregister Ubuntu-24.04` — removes WSL distro
4. Delete `~/.wslconfig`
5. Server falls back to direct pty mode (current behavior)

## Desktop Migration Path

All setup is captured in `install.sh`. On the new desktop:
1. `git clone` the repo
2. `bash install.sh` — handles WSL, tmux, Tailscale, service, watchdog
3. Copy `.telegram-token`, `.totp-secret`, `.credentials.json`, `config.json` from laptop
4. Re-register Face ID passkeys (rpID changes with new Tailscale hostname)
5. Scheduled tasks re-created by `install.sh` (ClaudeMobile + ClaudeMobileWatchdog)

## Success Criteria

1. Claude conversations survive PM2 restarts (tmux persistence)
2. Server starts automatically on user login after reboot
3. Hung/crashed server recovers within 5 minutes
4. User receives Telegram notification on failure with actionable reason
5. WSL stays under 1GB RAM
