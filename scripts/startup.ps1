<#
.SYNOPSIS
  Brings the Claude Mobile stack up at logon.

.DESCRIPTION
  Registered as a Scheduled Task by register-startup.ps1. Restores the three
  things a reboot takes down, in dependency order:

    1. the WSL distro (which starts systemd, which starts the session backbone)
    2. tailscale serve, the HTTPS front door
    3. the Node server under PM2

  Every step is idempotent and verifies rather than assumes: the script is
  safe to run at any time, including while the stack is already up. Liveness
  is judged by the server's own HTTP endpoint, not by PM2 bookkeeping, since
  PM2 can report a process it has already lost.

  Actions are logged to ~/.claude-mobile-startup.log -- the May outage went
  unnoticed for weeks precisely because nothing recorded the failure.
#>
[CmdletBinding()]
param(
  # Resolved in the body, not here: $PSScriptRoot is not reliably populated
  # during param binding under PowerShell 5.1.
  [string]$InstallDir,
  [int]$Port = 3456,
  [string]$Distro = 'Ubuntu-24.04',
  [string]$AppName = 'claude-mobile'
)

$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $env:USERPROFILE '.claude-mobile-startup.log'

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Output $line
  try { Add-Content -LiteralPath $LogFile -Value $line -ErrorAction Stop } catch { }
}

function Test-ServerUp {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/auth/status" `
      -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

Write-Log 'INFO' "startup begin (InstallDir=$InstallDir, Port=$Port)"

# --- 1. WSL distro ---------------------------------------
# Booting the distro starts systemd, which starts claude-mobile-backbone,
# which holds the distro open so sessions outlive this Node process.
try {
  # Booting an already-running distro is a no-op, so just do it and trust the
  # exit code. `wsl --list --running` is NOT parsed here: it emits UTF-16LE,
  # which string-matches unreliably from PowerShell and silently reports the
  # distro as stopped when it is running.
  & wsl.exe -d $Distro -- /bin/true 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Log 'INFO' "WSL $Distro is running"
  } else {
    Write-Log 'ERROR' "could not start WSL $Distro (exit $LASTEXITCODE)"
  }

  $backbone = (& wsl.exe -d $Distro -u root -- systemctl is-active claude-mobile-backbone.service 2>&1) -join ''
  if ($backbone -match 'active') {
    Write-Log 'INFO' 'session backbone active'
  } else {
    Write-Log 'WARN' "session backbone not active (got '$backbone') -- attempting start"
    & wsl.exe -d $Distro -u root -- systemctl start claude-mobile-backbone.service 2>&1 | Out-Null
  }
} catch {
  Write-Log 'ERROR' "WSL step failed: $($_.Exception.Message)"
}

# --- 2. tailscale serve ----------------------------------
# The serve config lives in tailscaled and normally survives a reboot, but it
# is silently lost on a tailscaled state reset -- and losing it is invisible
# from the laptop, since localhost keeps working. Re-assert it every time.
try {
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  $tsExe = if ($ts) { $ts.Source } else { 'C:\Program Files\Tailscale\tailscale.exe' }

  if (Test-Path -LiteralPath $tsExe) {
    $status = (& $tsExe serve status 2>&1) -join "`n"
    if ($status -match "localhost:$Port") {
      Write-Log 'INFO' "tailscale serve already proxying to localhost:$Port"
    } else {
      Write-Log 'INFO' 're-asserting tailscale serve'
      & $tsExe serve --bg "http://localhost:$Port" 2>&1 | ForEach-Object { Write-Log 'INFO' "tailscale: $_" }
    }
  } else {
    Write-Log 'WARN' 'tailscale.exe not found -- remote access will be unavailable'
  }
} catch {
  Write-Log 'ERROR' "tailscale step failed: $($_.Exception.Message)"
}

# --- 3. Node server under PM2 ----------------------------
try {
  if (Test-ServerUp) {
    Write-Log 'INFO' "server already answering on port $Port -- nothing to do"
  } else {
    $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
    $pm2Exe = if ($pm2) { $pm2.Source } else { Join-Path $env:APPDATA 'npm\pm2.cmd' }

    if (-not (Test-Path -LiteralPath $pm2Exe)) {
      Write-Log 'ERROR' 'pm2 not found -- cannot start the server'
    } else {
      Write-Log 'INFO' 'server down -- pm2 resurrect'
      Push-Location $InstallDir
      & $pm2Exe resurrect 2>&1 | ForEach-Object { Write-Log 'INFO' "pm2: $_" }

      $up = $false
      foreach ($i in 1..10) { Start-Sleep -Seconds 2; if (Test-ServerUp) { $up = $true; break } }

      # resurrect only replays the saved dump; if that dump is missing or
      # stale the app never comes back, so fall back to an explicit start.
      if (-not $up) {
        Write-Log 'WARN' 'resurrect did not bring the server up -- starting explicitly'
        & $pm2Exe start server.js --name $AppName 2>&1 | ForEach-Object { Write-Log 'INFO' "pm2: $_" }
        foreach ($i in 1..10) { Start-Sleep -Seconds 2; if (Test-ServerUp) { $up = $true; break } }
        if ($up) {
          & $pm2Exe save 2>&1 | ForEach-Object { Write-Log 'INFO' "pm2: $_" }
          Write-Log 'INFO' 'pm2 dump refreshed'
        }
      }
      Pop-Location

      if ($up) { Write-Log 'INFO' 'server is up' }
      else { Write-Log 'ERROR' "server did NOT come up on port $Port" }
    }
  }
} catch {
  Write-Log 'ERROR' "PM2 step failed: $($_.Exception.Message)"
}

if (Test-ServerUp) {
  Write-Log 'INFO' 'startup complete -- stack healthy'
  exit 0
} else {
  Write-Log 'ERROR' 'startup complete -- stack UNHEALTHY'
  exit 1
}
