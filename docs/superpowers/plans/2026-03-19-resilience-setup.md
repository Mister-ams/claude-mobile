# Claude Mobile Resilience Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session persistence (WSL+tmux), auto-start (Task Scheduler), and health monitoring with Telegram alerts to Claude Mobile.

**Architecture:** Three independent layers — WSL+tmux for terminal persistence, Task Scheduler to resurrect PM2 on login, and a PowerShell watchdog that pings `/health` and sends Telegram alerts on failure. Zero new npm dependencies.

**Tech Stack:** Node.js (existing), WSL2 Ubuntu-24.04, tmux, Windows Task Scheduler, PowerShell, Telegram Bot API

**Spec:** `docs/superpowers/specs/2026-03-19-resilience-setup-design.md`

**Execution order:** All code changes first (Tasks 1-8), then automated WSL setup script (Task 9), then run it (Task 10), then verify (Task 11). Code tasks work in degraded mode until WSL is installed — no dependency on system setup.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server.js` | Modify | Add `wslAvailable` flag, WSL probe with retry, direct-pty fallback in `createSession`, `/health` endpoint (localhost-only), startup audit line, `lastError` wiring |
| `watchdog.ps1` | Create | Health check, PM2 restart, WSL restart, Telegram alerts, consecutive-failure tracking |
| `setup-wsl.ps1` | Create | Self-executing: WSL install, reboot, post-reboot Ubuntu+tmux+Task Scheduler setup, Telegram confirmation |
| `install.sh` | Modify | Trim WSL packages to tmux-only, add `.wslconfig` creation, add Task Scheduler + watchdog registration |
| `update.sh` | Modify | Remove WSL Claude Code update, add WSL health check |
| `.gitignore` | Modify | Add `.telegram-token`, `.watchdog-state`, `.restart-count`, `pm2-resurrect.cmd` |

---

### Task 1: Add WSL Availability Check to server.js

**Files:**
- Modify: `server.js:22-30` (after WSL constants, before `wslExec`)

- [ ] **Step 1: Add `wslAvailable` flag and probe function after line 24**

Insert after `const TMUX_PREFIX = 'cm';` (line 24):

```javascript
let wslAvailable = false;
let lastError = null; // { message, timestamp }

function probeWSL() {
  try {
    execSync(`wsl -d ${WSL_DISTRO} -- echo 1`, { encoding: 'utf8', timeout: 5000 });
    wslAvailable = true;
    return true;
  } catch (e) {
    wslAvailable = false;
    return false;
  }
}
```

- [ ] **Step 2: Add startup WSL probe with retry before `server.listen`**

Insert before `server.listen(PORT, 'localhost', () => {` (line 1517):

```javascript
// ─── WSL probe with retry ────────────────────────────────────────
function initWSL(retries = 6, interval = 5000) {
  if (probeWSL()) {
    console.log(`  WSL:      ${WSL_DISTRO} available`);
    // Periodic re-check so /health detects WSL crashes
    setInterval(() => { probeWSL(); }, 30000);
    return;
  }
  if (retries <= 0) {
    console.log('  WSL:      UNAVAILABLE — running in degraded mode (no tmux persistence)');
    audit('SYSTEM', 'WSL unavailable after retries — degraded mode');
    // Re-check every 30s in background
    const recheck = setInterval(() => {
      if (probeWSL()) {
        console.log('  WSL: now available — tmux mode enabled');
        audit('SYSTEM', 'WSL became available — tmux mode enabled');
        clearInterval(recheck);
        // Continue periodic health checks
        setInterval(() => { probeWSL(); }, 30000);
        recoverTmuxSessions();
      }
    }, 30000);
    return;
  }
  console.log(`  WSL:      waiting for ${WSL_DISTRO}... (${retries} retries left)`);
  setTimeout(() => initWSL(retries - 1, interval), interval);
}

initWSL();
```

- [ ] **Step 3: Guard `recoverTmuxSessions` in server.listen callback**

In the `server.listen` callback (line 1546), replace:
```javascript
  recoverTmuxSessions();
  if (sessions.size === 0) autoStartSessions();
```

With:
```javascript
  if (wslAvailable) recoverTmuxSessions();
  if (sessions.size === 0) autoStartSessions();
```

This prevents a race condition where `initWSL` is still retrying in the background when `server.listen` fires.

- [ ] **Step 4: Run server to verify probe works (expect degraded mode since WSL not installed yet)**

```bash
cd /c/Users/abdul/claude-mobile && node server.js
```

Expected: `WSL: UNAVAILABLE — running in degraded mode` in startup output. Ctrl+C to stop. This is correct — WSL will be installed in Task 10.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add server.js && git commit -m "feat: add WSL availability probe with retry on startup"
```

---

### Task 2: Add Direct-PTY Fallback to `createSession`

**Files:**
- Modify: `server.js:951-976` (`createSession` function)

- [ ] **Step 1: Add direct-pty session creation function**

Insert before `createSession` (before line 951):

```javascript
function createDirectPtySession(name, dir, cols, rows) {
  const c = Math.max(10, Math.min(500, parseInt(cols, 10) || 50));
  const r = Math.max(5, Math.min(200, parseInt(rows, 10) || 30));
  return pty.spawn('cmd.exe', ['/c', 'claude'], {
    name: 'xterm-256color',
    cols: c, rows: r,
    cwd: dir,
    env: getSafeEnv()
  });
}
```

- [ ] **Step 2: Modify `createSession` to use fallback when WSL unavailable**

Replace the `createSession` function (lines 951-976) with:

```javascript
function createSession(name, dir, cols, rows) {
  if (sessions.size >= MAX_SESSIONS) return null;
  const id = nextId++;

  let proc, tmux = null;

  if (wslAvailable) {
    // Full mode: tmux session persistence via WSL
    tmux = tmuxName(id);
    const wslDir = winPathToWsl(dir);
    try {
      createTmuxSession(tmux, wslDir, cols, rows);
      proc = attachToTmux(tmux, 80, 24);
    } catch (e) {
      audit('ERROR', `tmux create failed: ${e.message}`);
      // Fall through to direct pty
      tmux = null;
    }
  }

  if (!proc) {
    // Degraded mode: direct pty (no persistence)
    try {
      proc = createDirectPtySession(name, dir, cols, rows);
      audit('SESSION', `Created (direct pty, no persistence): "${name}" in ${dir}`);
    } catch (e) {
      audit('ERROR', `Direct pty failed: ${e.message}`);
      return null;
    }
  }

  const session = {
    id, name, dir, tmuxName: tmux, proc, scrollback: '',
    attention: null, attentionTimer: null, clients: new Set()
  };

  wireSessionProc(session);
  sessions.set(id, session);
  if (tmux) audit('SESSION', `Created: "${name}" in ${dir} (tmux: ${tmux})`);
  saveSessionMeta();
  return session;
}
```

- [ ] **Step 3: Test — restart PM2 and verify degraded mode works**

```bash
cd /c/Users/abdul/claude-mobile && pm2 restart claude-mobile && sleep 3 && pm2 logs claude-mobile --lines 10 --nostream
```

Expected: startup log shows `WSL: UNAVAILABLE — running in degraded mode`. Sessions still creatable from phone (direct pty).

- [ ] **Step 4: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add server.js && git commit -m "feat: add direct-pty fallback when WSL unavailable"
```

---

### Task 3: Add `/health` Endpoint (Localhost-Only)

**Files:**
- Modify: `server.js` (after existing `app.post('/api/upload', ...)` route, before WebSocket section)

- [ ] **Step 1: Find the insertion point**

The `/health` endpoint goes after the last `app.post`/`app.get` route and before the WebSocket section. Search for `// ─── WebSocket` in server.js to find the boundary.

- [ ] **Step 2: Add the `/health` endpoint**

Insert before `// ─── WebSocket`:

```javascript
// ─── Health check (localhost only) ───────────────────────────────
app.get('/health', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).json({ error: 'localhost only' });
  }

  const mem = process.memoryUsage();
  res.json({
    status: wslAvailable ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    sessions: sessions.size,
    wsl: wslAvailable,
    memory: {
      rss: Math.round(mem.rss / 1048576),
      heap: Math.round(mem.heapUsed / 1048576)
    },
    lastError: lastError && (Date.now() - lastError.timestamp < 3600000) ? lastError : null
  });
});
```

- [ ] **Step 3: Test `/health` from localhost**

```bash
curl.exe http://localhost:3456/health
```

Expected: JSON with `status: "degraded"` (WSL not installed yet), `uptime`, `sessions`, `wsl: false`, `memory`

- [ ] **Step 4: Verify Tailscale request is blocked**

```bash
curl.exe -s -o /dev/null -w "%{http_code}" https://ad-lap-7.tailfe2601.ts.net/health
```

Expected: `403`

- [ ] **Step 5: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add server.js && git commit -m "feat: add /health endpoint (localhost-only)"
```

---

### Task 4: Add Startup Audit Line

**Files:**
- Modify: `server.js:1548` (inside `server.listen` callback, after `audit('SYSTEM', ...)`)

- [ ] **Step 1: Add restart tracking and enhanced startup audit**

Add at the top of server.js, after the `lastError` declaration:

```javascript
let restartCount = 0;
const RESTART_COUNT_FILE = path.join(__dirname, '.restart-count');
try {
  restartCount = parseInt(fs.readFileSync(RESTART_COUNT_FILE, 'utf8').trim()) || 0;
} catch {}
restartCount++;
try { fs.writeFileSync(RESTART_COUNT_FILE, String(restartCount)); } catch {}
```

- [ ] **Step 2: Replace the existing audit line in server.listen callback**

Replace `audit('SYSTEM', `Server started on port ${PORT}`);` with:

```javascript
  audit('SYSTEM', `Server started | restart_count: ${restartCount} | wsl: ${wslAvailable}`);
```

- [ ] **Step 3: Test — restart and check audit log**

```bash
pm2 restart claude-mobile && sleep 3 && tail -5 /c/Users/abdul/.claude-mobile-audit.log
```

Expected: last line shows `[SYSTEM] Server started | restart_count: N | wsl: false`

- [ ] **Step 4: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add server.js && git commit -m "feat: add startup audit line with restart count and WSL status"
```

---

### Task 5: Wire `lastError` into Error Paths

**Files:**
- Modify: `server.js` (existing `audit('ERROR', ...)` calls)

- [ ] **Step 1: Add `setLastError` helper after the `lastError` declaration**

```javascript
function setLastError(message) {
  lastError = { message, timestamp: Date.now() };
}
```

- [ ] **Step 2: Wire into existing error audit calls**

Find all `audit('ERROR', ...)` calls in server.js and add `setLastError` after each one. There are ~5 instances. For each one, add:

```javascript
setLastError(e.message || message);
```

For example, in `createSession`:
```javascript
audit('ERROR', `tmux create failed: ${e.message}`);
setLastError(`tmux create failed: ${e.message}`);
```

And in `recoverTmuxSessions`:
```javascript
audit('ERROR', `Recovery failed for ${tmux}: ${e.message}`);
setLastError(`Recovery failed for ${tmux}: ${e.message}`);
```

- [ ] **Step 3: Test — verify lastError appears in /health after error**

```bash
curl.exe http://localhost:3456/health | python3 -m json.tool
```

Expected: `lastError: null` (no recent errors). After triggering an error, `lastError` should contain the message and timestamp.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add server.js && git commit -m "feat: wire lastError into error paths for /health visibility"
```

---

### Task 6: Create Watchdog Script

**Files:**
- Create: `watchdog.ps1`
- Modify: `.gitignore`

- [ ] **Step 1: Create `watchdog.ps1`**

```powershell
# Claude Mobile Watchdog
# Runs every 5 minutes via Task Scheduler.
# Checks /health, restarts PM2 on failure, sends Telegram alerts.

$ErrorActionPreference = "SilentlyContinue"

$HealthUrl = "http://localhost:3456/health"
$StateFile = "$PSScriptRoot\.watchdog-state"
$TokenFile = "$PSScriptRoot\.telegram-token"
$ChatId = "496270209"
$Timeout = 10
$Pm2Path = "C:\Users\abdul\AppData\Roaming\fnm\node-versions\v22.22.1\installation\pm2"

# ── Load state ──
$state = @{ failures = 0; alertSent = $false }
if (Test-Path $StateFile) {
    try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json } catch {}
}

function Save-State {
    $state | ConvertTo-Json | Set-Content $StateFile
}

function Send-Telegram($message) {
    if (-not (Test-Path $TokenFile)) { return }
    $token = (Get-Content $TokenFile -Raw).Trim()
    $body = @{ chat_id = $ChatId; text = $message; parse_mode = "HTML" } | ConvertTo-Json
    try {
        curl.exe -s -X POST "https://api.telegram.org/bot$token/sendMessage" `
            -H "Content-Type: application/json" -d $body | Out-Null
    } catch {}
}

# ── Health check ──
$healthy = $false
$reason = "unknown"
$wslDown = $false

try {
    $response = curl.exe -s --connect-timeout $Timeout --max-time $Timeout $HealthUrl 2>$null
    if ($LASTEXITCODE -eq 0 -and $response) {
        $health = $response | ConvertFrom-Json
        if ($health.status -eq "ok") {
            $healthy = $true
        } elseif ($health.status -eq "degraded") {
            $reason = "WSL unavailable"
            $wslDown = $true
        } else {
            $reason = "status: $($health.status)"
        }
    } else {
        $reason = "health check timeout/unreachable"
    }
} catch {
    $reason = "health check failed: $($_.Exception.Message)"
}

# ── Act on result ──
if ($healthy) {
    if ($state.alertSent) {
        Send-Telegram "Claude Mobile recovered"
        $state.alertSent = $false
    }
    $state.failures = 0
    Save-State
    exit 0
}

# Failure path
$state.failures++

if ($state.failures -lt 2) {
    # First failure — wait for next check (avoid false positives)
    Save-State
    exit 0
}

# 2+ consecutive failures — take action
if ($wslDown) {
    # Try to restart WSL before PM2
    wsl --shutdown 2>$null
    Start-Sleep -Seconds 3
    wsl -d Ubuntu-24.04 -- echo 1 2>$null
    Start-Sleep -Seconds 2
}

# Restart PM2
$env:PATH = "C:\Users\abdul\AppData\Roaming\fnm\node-versions\v22.22.1\installation;$env:PATH"
$pmResult = pm2 restart claude-mobile 2>&1
$restarted = $LASTEXITCODE -eq 0

if ($restarted) {
    Send-Telegram "Claude Mobile restarted -- reason: $reason"
    $state.alertSent = $true
} else {
    Send-Telegram "Claude Mobile DOWN -- manual intervention needed (reason: $reason, pm2: $pmResult)"
    $state.alertSent = $true
}

Save-State
```

- [ ] **Step 2: Update `.gitignore`**

Append to `.gitignore`:

```
.watchdog-state
.telegram-token
.restart-count
pm2-resurrect.cmd
```

- [ ] **Step 3: Test watchdog with server running**

```bash
powershell -ExecutionPolicy Bypass -File C:\\Users\\abdul\\claude-mobile\\watchdog.ps1
```

Expected: exits cleanly (server is healthy). Check that `.watchdog-state` was created with `failures: 0`.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add watchdog.ps1 .gitignore && git commit -m "feat: add watchdog script with Telegram alerts"
```

---

### Task 7: Update `install.sh`

**Files:**
- Modify: `install.sh:146-191` (Step 5: WSL + tmux section)

- [ ] **Step 1: Replace the WSL install section (lines 150-191)**

Replace the entire `if $IS_WINDOWS; then` block (lines 150-191) with:

```bash
if $IS_WINDOWS; then
  say "Step 5/7: Setting up WSL + tmux for session persistence..."

  # Create .wslconfig with memory cap
  WSLCONFIG="$HOME/.wslconfig"
  if [ ! -f "$WSLCONFIG" ]; then
    cat > "$WSLCONFIG" << WSLEOF
[wsl2]
memory=1GB
swap=256MB
WSLEOF
    ok ".wslconfig created (1GB memory cap, 256MB swap)"
  else
    ok ".wslconfig already exists"
  fi

  # Check if Ubuntu-24.04 is already installed
  WSL_INSTALLED=false
  if wsl --list --quiet 2>/dev/null | grep -qi "Ubuntu-24.04"; then
    WSL_INSTALLED=true
    ok "WSL Ubuntu-24.04 already installed"
  fi

  if ! $WSL_INSTALLED; then
    say "Installing WSL Ubuntu-24.04 (this may take a few minutes)..."
    wsl --install Ubuntu-24.04 --no-launch 2>&1 | tail -3
    ok "Ubuntu-24.04 installed"
  fi

  # Install tmux only (no Node, PM2, or Claude -- they run on Windows)
  say "Installing tmux in WSL..."
  wsl -d Ubuntu-24.04 -u root -- bash -c "
    apt-get update -qq && apt-get install -y -qq tmux > /dev/null 2>&1
    echo \"tmux \$(tmux -V | cut -d' ' -f2)\"
  " 2>/dev/null && ok "tmux installed in WSL" || warn "tmux install had issues"

  # Register Task Scheduler jobs
  say "Registering auto-start task..."
  PM2_PATH="$(cygpath -w "$(dirname "$(which pm2)")")"
  cat > "$INSTALL_DIR/pm2-resurrect.cmd" << CMDEOF
@echo off
set PATH=$PM2_PATH;%PATH%
pm2 resurrect
CMDEOF
  schtasks //Create //TN "ClaudeMobile" //TR "$(cygpath -w "$INSTALL_DIR/pm2-resurrect.cmd")" //SC ONLOGON //RL HIGHEST //F > /dev/null 2>&1 \
    && ok "ClaudeMobile auto-start registered" \
    || warn "Could not register auto-start task"

  say "Registering watchdog task..."
  WATCHDOG_CMD="powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File $(cygpath -w "$INSTALL_DIR/watchdog.ps1")"
  schtasks //Create //TN "ClaudeMobileWatchdog" //TR "$WATCHDOG_CMD" //SC MINUTE //MO 5 //RL HIGHEST //F > /dev/null 2>&1 \
    && ok "Watchdog registered (every 5 min)" \
    || warn "Could not register watchdog task"

else
  say "Step 5/7: tmux setup..."
  if command -v tmux &>/dev/null; then
    ok "tmux $(tmux -V | cut -d' ' -f2) found"
  else
    warn "tmux not found. Install it for session persistence:"
    echo -e "    macOS: ${DIM}brew install tmux${RESET}"
    echo -e "    Linux: ${DIM}sudo apt install tmux${RESET}"
  fi
fi
```

- [ ] **Step 2: Verify script syntax**

```bash
bash -n /c/Users/abdul/claude-mobile/install.sh
```

Expected: no output (no syntax errors).

- [ ] **Step 3: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add install.sh && git commit -m "feat: update install.sh — tmux-only WSL, Task Scheduler registration"
```

---

### Task 8: Update `update.sh`

**Files:**
- Modify: `update.sh:78-83` (WSL update section)

- [ ] **Step 1: Replace WSL update section (lines 78-83)**

Replace:
```bash
if $IS_WINDOWS && wsl --list --quiet 2>/dev/null | grep -qi "Ubuntu-24.04"; then
  say "Updating WSL tools..."
  wsl -d Ubuntu-24.04 -u root -- bash -c "
    npm update -g @anthropic-ai/claude-code 2>/dev/null | tail -1
  " 2>/dev/null && ok "WSL Claude Code updated" || warn "WSL update skipped"
fi
```

With:
```bash
if $IS_WINDOWS && wsl --list --quiet 2>/dev/null | grep -qi "Ubuntu-24.04"; then
  say "Checking WSL health..."
  if wsl -d Ubuntu-24.04 -- echo 1 > /dev/null 2>&1; then
    ok "WSL Ubuntu-24.04 responsive"
  else
    warn "WSL not responding -- try: wsl --shutdown && wsl -d Ubuntu-24.04 -- echo 1"
  fi
fi
```

- [ ] **Step 2: Verify script syntax**

```bash
bash -n /c/Users/abdul/claude-mobile/update.sh
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add update.sh && git commit -m "refactor: replace WSL Claude update with WSL health check in update.sh"
```

---

### Task 9: Create Self-Executing WSL Setup Script

**Files:**
- Create: `setup-wsl.ps1`

This script handles everything: WSL install, reboot, and post-reboot automation. User runs ONE command, approves ONE UAC prompt, walks away.

- [ ] **Step 1: Create `setup-wsl.ps1`**

```powershell
#Requires -RunAsAdministrator
# Claude Mobile — WSL Setup (self-executing)
# 1. Creates .wslconfig
# 2. Enables WSL + installs Ubuntu-24.04
# 3. Registers a one-time post-reboot task to finish setup
# 4. Reboots
#
# After reboot, the one-time task:
#   - Installs tmux in WSL
#   - Creates pm2-resurrect.cmd
#   - Registers ClaudeMobile + ClaudeMobileWatchdog scheduled tasks
#   - Configures PM2 with memory limit
#   - Sends Telegram "setup complete" message
#   - Deletes itself

$ErrorActionPreference = "Stop"
$ProjectDir = "C:\Users\abdul\claude-mobile"
$FnmNodeDir = "C:\Users\abdul\AppData\Roaming\fnm\node-versions\v22.22.1\installation"

Write-Host ""
Write-Host "  ======================================" -ForegroundColor Cyan
Write-Host "  Claude Mobile — WSL Setup" -ForegroundColor Cyan
Write-Host "  ======================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: .wslconfig ──
$wslconfig = "$env:USERPROFILE\.wslconfig"
if (-not (Test-Path $wslconfig)) {
    @"
[wsl2]
memory=1GB
swap=256MB
"@ | Set-Content $wslconfig -Encoding UTF8
    Write-Host "  [OK] .wslconfig created (1GB cap, 256MB swap)" -ForegroundColor Green
} else {
    Write-Host "  [OK] .wslconfig already exists" -ForegroundColor Green
}

# ── Step 2: Install WSL ──
Write-Host "  Installing WSL + Ubuntu-24.04..." -ForegroundColor Cyan
Write-Host "  (This may take several minutes)" -ForegroundColor DarkGray
wsl --install Ubuntu-24.04 --no-launch 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

# ── Step 3: Register post-reboot task ──
$postRebootScript = @"
`$ErrorActionPreference = "SilentlyContinue"
`$ProjectDir = "$ProjectDir"
`$FnmNodeDir = "$FnmNodeDir"
`$env:PATH = "`$FnmNodeDir;`$env:PATH"

# Wait for WSL to be ready (up to 2 minutes)
`$ready = `$false
for (`$i = 0; `$i -lt 24; `$i++) {
    `$result = wsl -d Ubuntu-24.04 -- echo 1 2>&1
    if (`$LASTEXITCODE -eq 0) { `$ready = `$true; break }
    Start-Sleep -Seconds 5
}
if (-not `$ready) {
    # Log failure and exit
    "WSL not ready after 2 minutes" | Out-File "`$ProjectDir\setup-wsl.log" -Append
    exit 1
}

# Install tmux
wsl -d Ubuntu-24.04 -u root -- bash -c "apt-get update -qq && apt-get install -y -qq tmux > /dev/null 2>&1"
"tmux installed" | Out-File "`$ProjectDir\setup-wsl.log" -Append

# Create pm2-resurrect.cmd
@"
@echo off
set PATH=`$FnmNodeDir;%PATH%
pm2 resurrect
"@ | Set-Content "`$ProjectDir\pm2-resurrect.cmd" -Encoding ASCII

# Register ClaudeMobile auto-start
schtasks /Create /TN "ClaudeMobile" /TR "`$ProjectDir\pm2-resurrect.cmd" /SC ONLOGON /RL HIGHEST /F 2>&1 | Out-Null
"ClaudeMobile task registered" | Out-File "`$ProjectDir\setup-wsl.log" -Append

# Register ClaudeMobileWatchdog (every 5 min)
`$watchdogCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `$ProjectDir\watchdog.ps1"
schtasks /Create /TN "ClaudeMobileWatchdog" /TR `$watchdogCmd /SC MINUTE /MO 5 /RL HIGHEST /F 2>&1 | Out-Null
"Watchdog task registered" | Out-File "`$ProjectDir\setup-wsl.log" -Append

# Configure PM2 with memory limit
pm2 delete claude-mobile 2>&1 | Out-Null
pm2 start "`$ProjectDir\server.js" --name claude-mobile --max-memory-restart 750M 2>&1 | Out-Null
pm2 save 2>&1 | Out-Null
"PM2 configured with 750M limit" | Out-File "`$ProjectDir\setup-wsl.log" -Append

# Send Telegram confirmation
`$tokenFile = "`$ProjectDir\.telegram-token"
if (Test-Path `$tokenFile) {
    `$token = (Get-Content `$tokenFile -Raw).Trim()
    `$body = @{ chat_id = "496270209"; text = "Claude Mobile setup complete — WSL + tmux + auto-start + watchdog all configured"; parse_mode = "HTML" } | ConvertTo-Json
    curl.exe -s -X POST "https://api.telegram.org/bot`$token/sendMessage" -H "Content-Type: application/json" -d `$body 2>&1 | Out-Null
}

# Clean up: delete this one-time task
schtasks /Delete /TN "ClaudeMobilePostSetup" /F 2>&1 | Out-Null
"Setup complete" | Out-File "`$ProjectDir\setup-wsl.log" -Append
"@

$postRebootPath = "$ProjectDir\post-reboot-setup.ps1"
$postRebootScript | Set-Content $postRebootPath -Encoding UTF8

$taskCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File $postRebootPath"
schtasks /Create /TN "ClaudeMobilePostSetup" /TR $taskCmd /SC ONLOGON /RL HIGHEST /F 2>&1 | Out-Null
Write-Host "  [OK] Post-reboot task registered" -ForegroundColor Green

# ── Step 4: Reboot ──
Write-Host ""
Write-Host "  Setup will complete automatically after reboot." -ForegroundColor Yellow
Write-Host "  You'll receive a Telegram message when done." -ForegroundColor Yellow
Write-Host ""
$confirm = Read-Host "  Reboot now? (y/n)"
if ($confirm -eq "y" -or $confirm -eq "Y") {
    Write-Host "  Rebooting in 5 seconds..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
    Restart-Computer -Force
} else {
    Write-Host "  Reboot manually when ready. Setup will complete on next login." -ForegroundColor Yellow
}
```

- [ ] **Step 2: Add setup files to `.gitignore`**

Append to `.gitignore`:

```
post-reboot-setup.ps1
setup-wsl.log
```

- [ ] **Step 3: Commit**

```bash
cd /c/Users/abdul/claude-mobile && git add setup-wsl.ps1 .gitignore && git commit -m "feat: add self-executing WSL setup script with post-reboot automation"
```

---

### Task 10: Run WSL Setup

- [ ] **Step 1: Ensure `.telegram-token` exists**

```bash
test -f /c/Users/abdul/claude-mobile/.telegram-token && echo "exists" || echo "MISSING — create it first"
```

If missing, create it with the bot token for `@Bmw_x5_abdulla_bot`.

- [ ] **Step 2: Run the setup script (triggers UAC + reboot)**

```bash
powershell -Command "Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File C:\Users\abdul\claude-mobile\setup-wsl.ps1' -Verb RunAs"
```

This opens an elevated PowerShell window, installs WSL, and prompts for reboot.

- [ ] **Step 3: After reboot — verify post-reboot task ran**

```bash
cat /c/Users/abdul/claude-mobile/setup-wsl.log
```

Expected: shows tmux installed, tasks registered, PM2 configured, setup complete.

- [ ] **Step 4: Verify WSL + tmux**

```bash
wsl -d Ubuntu-24.04 -u root -- bash -c "tmux -V && echo OK"
```

Expected: `tmux 3.x` and `OK`

- [ ] **Step 5: Verify scheduled tasks**

```bash
schtasks //Query //TN "ClaudeMobile" && schtasks //Query //TN "ClaudeMobileWatchdog"
```

Expected: both tasks shown.

- [ ] **Step 6: Verify PM2 running with memory limit**

```bash
pm2 list && pm2 describe claude-mobile | grep "max memory"
```

Expected: claude-mobile online, 750M memory limit.

- [ ] **Step 7: Check Telegram for confirmation message**

Expected: received "Claude Mobile setup complete" message.

---

### Task 11: End-to-End Verification

- [ ] **Step 1: Verify success criterion 1 — session persistence**

1. Open Claude Mobile on phone, create a session
2. Type something in the Claude conversation
3. Restart PM2: `pm2 restart claude-mobile`
4. Reconnect from phone
5. Verify: previous conversation is still there (tmux recovered it)

- [ ] **Step 2: Verify success criterion 2 — auto-start on login**

1. `pm2 kill` (stops PM2 daemon entirely)
2. Run: `schtasks //Run //TN "ClaudeMobile"`
3. Wait 5 seconds, then `pm2 list`
4. Verify: claude-mobile is online

- [ ] **Step 3: Verify success criterion 3 — watchdog recovery**

1. `pm2 stop claude-mobile`
2. Wait 10 minutes (2 watchdog cycles)
3. `pm2 list`
4. Verify: claude-mobile was restarted by watchdog
5. Check Telegram: should have received restart alert

- [ ] **Step 4: Verify success criterion 4 — Telegram alert content**

Check Telegram for message containing the failure reason (e.g., "health check timeout/unreachable").

- [ ] **Step 5: Verify success criterion 5 — WSL memory**

```bash
wsl -d Ubuntu-24.04 -- free -m | head -2
```

Verify total is ~1024MB.

- [ ] **Step 6: Verify /health endpoint**

```bash
curl.exe http://localhost:3456/health
```

Verify: returns JSON with all fields populated, `wsl: true`, `status: ok`.

- [ ] **Step 7: Final commit — mark spec as complete**

```bash
cd /c/Users/abdul/claude-mobile && sed -i 's/^**Status:** Draft/**Status:** Complete/' docs/superpowers/specs/2026-03-19-resilience-setup-design.md && git add docs/ && git commit -m "docs: mark resilience setup spec as complete"
```
