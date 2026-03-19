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
Write-Host "  Claude Mobile - WSL Setup" -ForegroundColor Cyan
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
$postRebootScript = @'
$ErrorActionPreference = "SilentlyContinue"
$ProjectDir = "C:\Users\abdul\claude-mobile"
$FnmNodeDir = "C:\Users\abdul\AppData\Roaming\fnm\node-versions\v22.22.1\installation"
$env:PATH = "$FnmNodeDir;$env:PATH"

# Wait for WSL to be ready (up to 2 minutes)
$ready = $false
for ($i = 0; $i -lt 24; $i++) {
    $result = wsl -d Ubuntu-24.04 -- echo 1 2>&1
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 5
}
if (-not $ready) {
    "WSL not ready after 2 minutes" | Out-File "$ProjectDir\setup-wsl.log" -Append
    exit 1
}

# Install tmux
wsl -d Ubuntu-24.04 -u root -- bash -c "apt-get update -qq && apt-get install -y -qq tmux > /dev/null 2>&1"
"tmux installed" | Out-File "$ProjectDir\setup-wsl.log" -Append

# Create pm2-resurrect.cmd
@"
@echo off
set PATH=$FnmNodeDir;%PATH%
pm2 resurrect
"@ | Set-Content "$ProjectDir\pm2-resurrect.cmd" -Encoding ASCII

# Register ClaudeMobile auto-start
schtasks /Create /TN "ClaudeMobile" /TR "$ProjectDir\pm2-resurrect.cmd" /SC ONLOGON /RL HIGHEST /F 2>&1 | Out-Null
"ClaudeMobile task registered" | Out-File "$ProjectDir\setup-wsl.log" -Append

# Register ClaudeMobileWatchdog (every 5 min)
$watchdogCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File $ProjectDir\watchdog.ps1"
schtasks /Create /TN "ClaudeMobileWatchdog" /TR $watchdogCmd /SC MINUTE /MO 5 /RL HIGHEST /F 2>&1 | Out-Null
"Watchdog task registered" | Out-File "$ProjectDir\setup-wsl.log" -Append

# Configure PM2 with memory limit
pm2 delete claude-mobile 2>&1 | Out-Null
pm2 start "$ProjectDir\server.js" --name claude-mobile --max-memory-restart 750M 2>&1 | Out-Null
pm2 save 2>&1 | Out-Null
"PM2 configured with 750M limit" | Out-File "$ProjectDir\setup-wsl.log" -Append

# Send Telegram confirmation
$tokenFile = "$ProjectDir\.telegram-token"
if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
    $body = @{ chat_id = "496270209"; text = "Claude Mobile setup complete - WSL + tmux + auto-start + watchdog all configured"; parse_mode = "HTML" } | ConvertTo-Json
    curl.exe -s -X POST "https://api.telegram.org/bot$token/sendMessage" -H "Content-Type: application/json" -d $body 2>&1 | Out-Null
}

# Clean up: delete this one-time task and script
schtasks /Delete /TN "ClaudeMobilePostSetup" /F 2>&1 | Out-Null
Remove-Item "$ProjectDir\post-reboot-setup.ps1" -Force 2>&1 | Out-Null
"Setup complete" | Out-File "$ProjectDir\setup-wsl.log" -Append
'@

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
