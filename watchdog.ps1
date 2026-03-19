# Claude Mobile Watchdog
# Runs every 5 minutes via Task Scheduler.
# Checks /health, restarts PM2 on failure, sends Telegram alerts.

$ErrorActionPreference = "SilentlyContinue"

$HealthUrl = "http://localhost:3456/health"
$StateFile = "$PSScriptRoot\.watchdog-state"
$TokenFile = "$PSScriptRoot\.telegram-token"
$ChatId = "496270209"
$Timeout = 10

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

# Restart PM2 — resolve fnm node path dynamically (survives version upgrades)
$FnmBase = "$env:USERPROFILE\AppData\Roaming\fnm\node-versions"
$NodeDir = Get-ChildItem $FnmBase -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($NodeDir) { $env:PATH = "$($NodeDir.FullName)\installation;$env:PATH" }
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
