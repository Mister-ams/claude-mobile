<#
.SYNOPSIS
  Registers the Claude Mobile logon task (T09).

.DESCRIPTION
  Creates a Scheduled Task that runs scripts/startup.ps1 at user logon, which
  restores the WSL distro, tailscale serve, and the PM2-managed Node server.

  This closes the gap that caused the May outage: a reboot took the whole
  stack down and nothing brought it back, so the service was dead for weeks
  without anyone noticing.

  The task points at startup.ps1 rather than inlining the work, so boot
  behaviour can be changed without re-registering the task.

  Re-running this script re-registers the task from scratch (idempotent).

.PARAMETER InstallDir
  The live install directory -- the one PM2 and tailscale serve run against.
  Defaults to this script's parent. Pass it explicitly when running from a
  git worktree, or the task will point at the wrong tree.

.PARAMETER Unregister
  Remove the task instead of creating it.

.PARAMETER RunNow
  Run the task once immediately after registering, to prove it works without
  waiting for a reboot.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-startup.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-startup.ps1 -Unregister
#>
[CmdletBinding()]
param(
  # Resolved in the body, not here: $PSScriptRoot is not reliably populated
  # during param binding under PowerShell 5.1, which made the documented
  # no-argument invocation fail.
  [string]$InstallDir,
  [string]$TaskName = 'ClaudeMobile-Startup',
  [int]$Port = 3456,
  [string]$Distro = 'Ubuntu-24.04',
  [ValidateSet('Limited', 'Highest')]
  [string]$RunLevel = 'Limited',
  [switch]$Unregister,
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Split-Path -Parent $scriptDir
}

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task '$TaskName'"
  } else {
    Write-Output "No scheduled task '$TaskName' to remove"
  }
  return
}

$startupScript = Join-Path $scriptDir 'startup.ps1'
if (-not (Test-Path -LiteralPath $startupScript)) {
  throw "Cannot find $startupScript"
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'server.js'))) {
  throw "InstallDir '$InstallDir' does not contain server.js -- pass -InstallDir explicitly"
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argString = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden ' +
             '-File "{0}" -InstallDir "{1}" -Port {2} -Distro "{3}"' -f `
             $startupScript, $InstallDir, $Port, $Distro

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argString -WorkingDirectory $InstallDir

# 30s delay: at logon, tailscaled and the WSL service are usually still
# settling, and starting into a half-ready network just makes the script
# retry anyway.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT30S'

# Laptop: without AllowStartIfOnBatteries the task silently does not run when
# the machine boots unplugged, which is most of the time.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -MultipleInstances IgnoreNew

# RunLevel defaults to Limited so that registering does not itself require an
# elevated shell -- registering a Highest-level task needs admin, which would
# make install.sh fail for a normal user. Limited is enough for the two steps
# that matter: starting WSL and starting PM2.
#
# Only the tailscale serve re-assertion may need elevation, and that is a
# safety net rather than the primary mechanism (serve config persists inside
# tailscaled across reboots). startup.ps1 logs a warning if it cannot apply
# it. Pass -RunLevel Highest from an elevated shell if you want that step
# guaranteed.
#
# The task runs as the interactive user either way, so PM2 keeps the same
# PM2_HOME (%USERPROFILE%\.pm2) and therefore the same saved dump.
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel $RunLevel

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Starts the Claude Mobile stack (WSL distro, tailscale serve, PM2 server) at logon.' `
    -Force | Out-Null
} catch {
  if ($RunLevel -eq 'Highest') {
    throw "Registration failed ($($_.Exception.Message)). -RunLevel Highest requires an elevated shell; re-run elevated, or drop back to the default -RunLevel Limited."
  }
  throw
}

Write-Output "Registered scheduled task '$TaskName'"
Write-Output "  runs: $startupScript"
Write-Output "  against install dir: $InstallDir"
Write-Output "  trigger: at logon for $env:USERDOMAIN\$env:USERNAME (30s delay)"

if ($RunNow) {
  Write-Output 'Running the task once now...'
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 5
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Output "  last run: $($info.LastRunTime), result: $($info.LastTaskResult)"
}
