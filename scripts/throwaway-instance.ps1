<#
.SYNOPSIS
  Bring a THROWAWAY claude-mobile instance up or down for live testing.

.DESCRIPTION
  up    Runs server.js from the checkout this script lives in, on -Port
        (default 3457), herdr backend, session prefix -Prefix (default cmsim),
        as a plain background node process -- never pm2, so nothing can land in
        the pm2 reboot dump. Writes config.json, waits for /health, mints the
        instance's OWN TOTP via the localhost-only /api/setup/init and confirms
        it via /api/setup/verify. Prints the secret FILE path, never the value.

  down  Idempotent. Kills the recorded node process tree, then for every
        <Prefix>-N herdr session runs `herdr session stop` and
        `herdr session delete` (killing the server does NOT stop a herdr
        session -- they are orphaned on purpose), verifies none remain, frees
        the port, and removes only the state files `up` created.

  Safety: refuses port 3456, refuses the prefix `cm`, refuses to run from a
  checkout that is not a linked git worktree (the live instance is a main
  checkout), refuses when config.json already exists there, and refuses a
  node_modules that is a junction/symlink.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/throwaway-instance.ps1 up
  py test/ipad-webkit-live.py --port 3457 --totp-secret-file <printed path>
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/throwaway-instance.ps1 down
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('up', 'down')]
  [string]$Action,
  [int]$Port = 3457,
  [string]$Prefix = 'cmsim'
)

$ErrorActionPreference = 'Stop'

$LivePort = 3456
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HerdrBin = if ($env:HERDR_BIN) { $env:HERDR_BIN } else { Join-Path $HOME 'tools\herdr\herdr.exe' }
$StateDir = Join-Path $env:TEMP "cm-sim-$Port"
$StateFile = Join-Path $StateDir 'state.json'
$WorkDir = Join-Path $StateDir 'work'
# Everything server.js writes into its own directory. `down` removes only the
# ones that did not exist before `up`.
$InstanceFiles = @('config.json', '.totp-secret', '.credentials.json', '.server-identity-key', '.session-meta.json')
$SessionRe = '^' + [regex]::Escape($Prefix) + '-\d+$'

# An ambient HERDR_SESSION would redirect herdr calls to someone else's session.
Remove-Item Env:HERDR_SESSION -ErrorAction SilentlyContinue
Remove-Item Env:HERDR_PANE_ID -ErrorAction SilentlyContinue

function Fail([string]$msg) { Write-Output "FAIL: $msg"; exit 1 }

function Assert-Safe {
  if ($Port -eq $LivePort) { Fail "port $LivePort is the live instance" }
  if ($Prefix -notmatch '^[a-z][a-z0-9]*$') { Fail "prefix '$Prefix' must be lowercase alphanumeric" }
  if ($Prefix -eq 'cm') { Fail "prefix 'cm' is the live instance's" }
  if (-not (Test-Path $HerdrBin)) { Fail "herdr not found at $HerdrBin" }
}

function Get-HerdrSessions {
  $raw = & $HerdrBin session list --json
  if ($LASTEXITCODE -ne 0) { throw "herdr session list failed (exit $LASTEXITCODE)" }
  $parsed = ($raw -join "`n") | ConvertFrom-Json
  return @($parsed.sessions)
}

function Get-OurSessions { @(Get-HerdrSessions | Where-Object { $_.name -match $SessionRe }) }

function Get-Listener([int]$p) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Test-OurServer([int]$procId) {
  # Guard against PID reuse: only ever kill a node running server.js.
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  return ($proc.Name -eq 'node.exe' -and "$($proc.CommandLine)" -match 'server\.js')
}

function Stop-Tree([int]$procId) {
  # PS 5.1 turns redirected native stderr into a terminating error under
  # EAP=Stop; taskkill writes to stderr for already-exited children.
  $ErrorActionPreference = 'Continue'
  & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null
}

function Get-TotpCode {
  # Computed by the same library the server verifies with, from the file, so
  # the secret never passes through this script's output.
  $js = "const {TOTP,Secret}=require('otpauth');const s=JSON.parse(require('fs').readFileSync('.totp-secret','utf8')).secret;process.stdout.write(new TOTP({secret:Secret.fromBase32(s),digits:6,period:30}).generate())"
  Push-Location $Repo
  try { $code = & node -e $js } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0 -or "$code" -notmatch '^\d{6}$') { throw 'could not compute a TOTP code' }
  return "$code"
}

function Invoke-Down {
  $problems = @()
  $state = $null
  if (Test-Path $StateFile) { $state = Get-Content $StateFile -Raw | ConvertFrom-Json }

  # 1. the server process tree
  if ($state -and $state.pid) {
    if (Test-OurServer ([int]$state.pid)) {
      Stop-Tree ([int]$state.pid)
      Write-Output "killed server pid $($state.pid) (tree)"
    } else {
      Write-Output "server pid $($state.pid) already gone"
    }
  }
  $l = Get-Listener $Port
  if ($l -and (Test-OurServer ([int]$l.OwningProcess))) {
    Stop-Tree ([int]$l.OwningProcess)
    Write-Output "killed stray server on port $Port (pid $($l.OwningProcess))"
  }

  # 2. herdr sessions: stop, wait until not running, delete
  foreach ($s in (Get-OurSessions)) {
    if ($s.running) {
      & $HerdrBin session stop $s.name --json | Out-Null
      Write-Output "herdr session stop $($s.name) (exit $LASTEXITCODE)"
      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline) {
        $cur = @(Get-OurSessions | Where-Object { $_.name -eq $s.name -and $_.running })
        if ($cur.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
      }
    }
    & $HerdrBin session delete $s.name --json | Out-Null
    Write-Output "herdr session delete $($s.name) (exit $LASTEXITCODE)"
  }
  $left = @(Get-OurSessions)
  if ($left.Count -gt 0) { $problems += "herdr sessions remain: $(($left | ForEach-Object { $_.name }) -join ', ')" }

  # 3. the port
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Listener $Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  $l = Get-Listener $Port
  if ($l) { $problems += "port $Port still listening (pid $($l.OwningProcess))" }

  # 4. instance files this run created
  if ($state -and $state.createdFiles) {
    foreach ($f in $state.createdFiles) {
      $fp = Join-Path $Repo $f
      if (Test-Path -LiteralPath $fp -PathType Leaf) { Remove-Item -LiteralPath $fp -Force; Write-Output "removed $f" }
    }
  }
  if (Test-Path $StateFile) { Remove-Item -LiteralPath $StateFile -Force }

  if ($problems.Count -gt 0) { $problems | ForEach-Object { Write-Output "FAIL: $_" }; exit 1 }
  Write-Output "down: no $Prefix-* sessions, port $Port free (logs kept in $StateDir)"
}

function Invoke-Up {
  # Refusals first -- nothing is written until every one has passed.
  $gitDir = (& git -C $Repo rev-parse --path-format=absolute --git-dir).Trim()
  $common = (& git -C $Repo rev-parse --path-format=absolute --git-common-dir).Trim()
  if ($gitDir -eq $common) { Fail "$Repo is a main checkout, not a linked worktree -- refusing (the live instance is a main checkout)" }
  $nm = Join-Path $Repo 'node_modules'
  if (-not (Test-Path $nm)) { Fail "no node_modules in $Repo -- run npm ci there first" }
  if ((Get-Item $nm -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "node_modules is a junction/symlink -- this checkout needs its own install" }
  if (-not (Test-Path (Join-Path $nm 'node-pty'))) { Fail 'node-pty missing from node_modules' }
  if (Test-Path (Join-Path $Repo 'config.json')) { Fail "config.json already exists in $Repo -- refusing to overwrite it" }
  if (Test-Path $StateFile) { Fail "state file $StateFile exists -- run 'down' first" }
  if (Get-Listener $Port) { Fail "port $Port is in use" }
  $stale = @(Get-OurSessions)
  if ($stale.Count -gt 0) { Fail "leftover herdr sessions $(($stale | ForEach-Object { $_.name }) -join ', ') -- run 'down' first" }

  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $created = @($InstanceFiles | Where-Object { -not (Test-Path (Join-Path $Repo $_)) })

  $config = [ordered]@{
    port              = $Port
    inactivityTimeout = 15
    sessionBackend    = 'herdr'
    sessionPrefix     = $Prefix
    herdrBin          = $HerdrBin
    auditPath         = (Join-Path $StateDir 'audit.log')
    autoStart         = @()
    defaultDir        = $WorkDir
    projects          = @([ordered]@{ name = 'cmsim'; dir = $WorkDir })
  }
  # UTF-8 WITHOUT a BOM: JSON.parse rejects a BOM, and PS 5.1's -Encoding UTF8 writes one.
  [IO.File]::WriteAllText((Join-Path $Repo 'config.json'), ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

  $state = [ordered]@{ port = $Port; prefix = $Prefix; repo = $Repo; pid = $null; createdFiles = $created; startedAt = (Get-Date).ToString('o') }
  $saveState = { [IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false)) }
  & $saveState

  try {
    $env:PORT = "$Port"
    $proc = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $Repo -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $StateDir 'server.out.log') -RedirectStandardError (Join-Path $StateDir 'server.err.log')
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
    $state.pid = $proc.Id
    & $saveState
    Write-Output "server pid $($proc.Id) on port $Port (logs in $StateDir)"

    $health = $null
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $health -and (Get-Date) -lt $deadline) {
      if ($proc.HasExited) { throw "server exited (code $($proc.ExitCode)); see $StateDir\server.err.log" }
      try { $health = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 3 } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $health) { throw "no /health on $Port within 30s" }
    if ($health.backend -ne 'herdr') { throw "backend is '$($health.backend)', expected herdr" }
    Write-Output "health: status=$($health.status) backend=$($health.backend)"

    # Mint this instance's own TOTP. The response carries the secret; it is
    # dropped here and only the file path is reported.
    $hdr = @{ Origin = "http://localhost:$Port" }
    $init = Invoke-RestMethod -Method Post -Uri "http://localhost:$Port/api/setup/init" -Headers $hdr -ContentType 'application/json' -Body '{}'
    if ($init.error) { throw "setup/init: $($init.error)" }
    $init = $null
    $body = @{ code = (Get-TotpCode) } | ConvertTo-Json
    $ver = Invoke-RestMethod -Method Post -Uri "http://localhost:$Port/api/setup/verify" -Headers $hdr -ContentType 'application/json' -Body $body
    if (-not $ver.verified) { throw 'setup/verify rejected the code' }
    Write-Output 'totp: minted and verified'
    Write-Output "TOTP_SECRET_FILE=$(Join-Path $Repo '.totp-secret')"
    Write-Output "up: http://localhost:$Port  prefix $Prefix-*"
  } catch {
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
    Write-Output "up failed: $($_.Exception.Message) -- tearing down"
    Invoke-Down
    exit 1
  }
}

Assert-Safe
if ($Action -eq 'up') { Invoke-Up } else { Invoke-Down }
