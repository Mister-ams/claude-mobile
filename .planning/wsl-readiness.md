# WSL-First Migration Readiness Audit -- 2026-08-22

Read-only audit of AMS_LAPTOP_14 (Windows 11 26200, WSL 2.6.3.0, kernel 6.6.87.2-1,
distro Ubuntu-24.04, VHD /dev/sdd). Nothing was installed, modified, or restarted.

---

## READY (works today, no action)

### 1. systemd in WSL -- fully operational
- `/etc/wsl.conf` = `[boot] systemd=true` (that is the ENTIRE file; nothing else set).
- `systemctl is-system-running` -> `running`; zero failed units.
- `claude-mobile-backbone.service` already exists at /etc/systemd/system/, enabled,
  active since distro boot (13:37). It runs /usr/local/lib/claude-mobile/backbone-dtach.sh,
  `Restart=always`, `KillMode=process` (backbone restart never kills sessions),
  `User=root`. The unit file explicitly documents the W5 swap point: repoint ExecStart
  at `herdr daemon --socket /run/claude-mobile/herdr.sock`, nothing else moves.
- System units (root-owned) provably survive distro restart -- the backbone does it now.
  User units are NOT in use (`~/.config/systemd/user/` absent) and no user has linger
  enabled (`/var/lib/systemd/linger/` empty). If user units are ever wanted, `loginctl
  enable-linger` is required; untested on this box. The proven pattern here is system units.

### 2. Build toolchain for node-pty -- complete
- gcc/g++ 13.3.0 (Ubuntu 13.3.0-6ubuntu2~24.04.1), GNU Make 4.3, Python 3.12.3,
  build-essential 12.10ubuntu1 installed.
- No global node-gyp, but npm bundles node-gyp 11.2.0 (`npm ls -g` shows it deduped
  inside npm) -- that is what npm uses for install scripts, so `npm ci` compiling
  node-pty from source will work.
- dtach 0.9-5build1 installed.

### 3. Node in WSL -- present and sufficient
- WSL: node v22.22.1 (/usr/bin/node, nodesource apt package 22.22.1-1nodesource1,
  candidate 22.23.2), npm 10.9.4. Windows: node v24.13.1.
- claude-mobile package.json declares NO `engines` field. Deps: node-pty ^1.0.0,
  express ^4.21, ws ^8.18, @xterm/headless ^6.0, otpauth ^9.5, qrcode ^1.5,
  @simplewebauthn/server ^10.0. All fine on node 22 (LTS until 2027-04).
- The 22-vs-24 skew is a note, not a break; nodesource apt can move to 24 if wanted.

### 4. Disk headroom -- vast
- Inside WSL: /dev/sdd 1007G total, 61G used, 895G avail (7%).
- vhdx on disk: C:\Users\MRAL-\AppData\Local\wsl\{41ab292f-...}\ext4.vhdx = 74.3 GB
  sparse file; C: has ~465 GiB free, so growth room is real, not just nominal.
- Repo git stores are tiny: loomi-os size-pack 9.33 MiB, loomi-api 2.89 MiB,
  loomi-payments-service and claude-mobile only loose objects (never packed locally).
  Four clones + node_modules + venvs is single-digit GB. Fits with two orders of
  magnitude of margin.

### 5. No port conflicts inside WSL
- `ss -tlnp` in WSL: only DNS listeners (systemd-resolved on 127.0.0.53/54, WSL DNS
  proxy on 10.255.255.254:53). Port 3456 is free inside WSL.
- pm2 is already installed in WSL (/usr/bin/pm2) but NO pm2 daemon is running -- no
  conflict, and the binary being present saves an install.

### 6. Memory
- No %USERPROFILE%\.wslconfig exists AT ALL -> all defaults. WSL VM: 31 Gi RAM
  (default 50% of host), 8 Gi swap; currently 1.4 Gi used with 11 runner services +
  one session up. Plenty.

### 7. Tailscale front door
- `tailscale serve status`: https://ams-laptop-14.tail41c424.ts.net (tailnet only)
  -> proxy http://localhost:3456. This stays on Windows post-migration and carries
  over unchanged once a WSL listener owns 3456 via the localhost relay (Windows->WSL
  localhost verified working per prior measurement). See SURPRISE 6 for the ::1 caveat.

---

## NEEDS SETUP (must be installed/configured; exact commands)

### 1. Update the WSL Claude Code binary
- WSL: /usr/bin/claude -> /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js,
  version 2.1.78, file dated Mar 18. Windows runs 2.1.240. It is months stale because
  it has never been used (see BLOCKER 1 / SURPRISE 1).
- Command (operator, in WSL as root): `claude update`, or reinstall via the native
  installer (curl -fsSL https://claude.ai/install.sh | bash).

### 2. Protect dtach/herdr sockets from systemd-tmpfiles
- /tmp in this distro is NOT tmpfs (no separate mount; it is rootfs ext4). BUT
  /usr/lib/tmpfiles.d/tmp.conf has `D /tmp 1777 root root 30d`:
  (a) /tmp CONTENTS ARE PURGED AT EVERY DISTRO BOOT, and
  (b) daily tmpfiles-clean deletes entries untouched for 30 days -- a socket for a
  long-lived idle session can be deleted out from under a live dtach daemon.
- Boot purge is harmless today (sockets are dead after a restart anyway; the backbone
  script even counts stale sockets separately and deliberately never deletes them).
  The 30-day aging is a live-session risk that exists TODAY and carries over.
- Fix at migration: put sockets in /run/claude-mobile (the unit already anticipates
  this dir for herdr) with a tmpfiles.d entry, e.g.
  `echo 'd /run/claude-mobile 0700 root root -' > /etc/tmpfiles.d/claude-mobile.conf`
  or exclude the pattern: `echo 'x /tmp/cm-*.dtach' > /etc/tmpfiles.d/claude-mobile.conf`.
  Note /run IS tmpfs (cleared each boot) -- fine, since sockets do not survive boots.

### 3. WSL start at Windows boot -- keep and adapt the existing task
- Nothing starts WSL at BOOT. Two LOGON-time mechanisms exist:
  a) Scheduled task \ClaudeMobile-Startup: LogonTrigger for MRAL-, 30s delay,
     runs powershell scripts\startup.ps1 -Port 3456 -Distro Ubuntu-24.04. The script
     (1) runs `wsl -d Ubuntu-24.04 -- /bin/true` to boot the distro (systemd then
     starts the backbone; the script verifies and starts the backbone unit if
     inactive), (2) re-asserts `tailscale serve --bg http://localhost:3456` and
     CONFIRMS it took, (3) pm2 resurrect with explicit-start fallback + pm2 save.
     Logs to ~/.claude-mobile-startup.log; exit code reflects overall health.
  b) Startup-folder loomi-runner-keepalive.vbs: `wsl.exe -d Ubuntu-24.04 -u root
     -- sleep infinity` (for the CI runner pool).
- Post-migration the task is STILL required (something outside WSL must start WSL and
  re-assert tailscale serve); only step 3 changes (no Windows PM2 to resurrect --
  the server comes up inside WSL via its own systemd unit).
- Caveat unchanged from today: logon-triggered, not boot-triggered. An unattended
  reboot (power cut, forced update) leaves the whole stack down until someone logs in.
  If that is unacceptable, the task needs a boot trigger + stored credentials
  (operator decision; NOT a regression vs today).

### 4. config.json and repos are Windows-path-shaped
- claude-mobile/config.json: defaultDir C:\Users\MRAL-\Projects\loomi-os; projects =
  LOOMI OS / LOOMI API / LOOMI ETL / LOOMI Platform, all C:\ paths; autoStart=[LOOMI OS].
- server.js converts these to /mnt/c/... (winPathToWsl, server.js:1561) -- i.e. today
  sessions run in /mnt/c working directories (the measured 373x/48x penalty).
- Migration: clone repos to ext4 (~/... in WSL), rewrite config paths. Note the
  migration brief lists loomi-os, loomi-api, payments service; config.json currently
  lists ETL (retired) and Platform instead of the payments service -- reconcile.

### 5. External watchdog replacement for checkBackbone
- Today: server.js probeBackbone/checkBackbone (server.js ~2031-2079) runs from
  Windows inside the 60s housekeeping timer (server.js:2124): lsof over
  /tmp/cm-*.dtach via wslBash, flags wslDown, broadcasts backbone up/down banners.
  Moving the server into WSL makes this probe internal -- when WSL dies, the watcher
  dies with it.
- Windows-side mechanisms available today:
  a) ClaudeMobile-Startup startup.ps1 -- ALREADY designed as a watchdog: idempotent,
     verifies via HTTP /api/auth/status not PM2 bookkeeping, re-asserts every layer,
     logs, meaningful exit code. Adding a periodic trigger (e.g. every 10 min) to the
     existing task turns it into the external watchdog with zero new code. (Change =
     task re-registration; needs operator approval to modify.)
  b) PM2 God daemon (Windows, user MRAL-) -- only restarts a crashed node process;
     dies at logoff; resurrected at logon. Irrelevant once the server leaves Windows.
  c) packages/health-monitor (loomi-os) -- Railway CLOUD cron (monitor.py, notifier.py,
     abr_capture.py, ...). It watches deployed Railway services. It CANNOT watch this
     laptop: the serve URL is tailnet-only, Railway has no tailnet access. Not usable
     without exposing something publicly.
  d) Inside WSL: loomi-runner-heal.timer (OnBootSec=2min, OnUnitActiveSec=10min) heals
     CI runners after laptop sleep -- a pattern to copy, but it lives inside the VM,
     so it is not an EXTERNAL watchdog either.

---

## BLOCKER (operator decision or login required)

### 1. Claude Code in WSL is NOT authenticated
- /root/.claude/ contains only backups/, cache/, hooks/ (a herdr SessionStart hook),
  settings.json. NO .credentials.json. /root/.claude.json is 277 bytes with keys
  [theme, firstStartTime, opusProMigrationComplete, sonnet1m45MigrationComplete,
  userID, changelogLastFetched] -- no oauthAccount, no projects. Never logged in.
- No ANTHROPIC_* / API-key env vars found in running session processes or root profile.
- Today this does not matter because sessions run the WINDOWS claude (see SURPRISE 1),
  which IS authenticated (%USERPROFILE%\.claude\.credentials.json exists, v2.1.240).
- Operator login required in WSL before cutover: run `claude` (or `claude login`) as
  root in the distro; it prints an OAuth URL to open in the Windows browser and paste
  the code back. Nothing was attempted in this audit.
- Related decision: DefaultUid=0 -- the distro runs everything as root (backbone unit
  comment: "server.js runs wsl -u root, so session sockets are root-owned"). Staying
  root is least-change; introducing a non-root service user changes socket ownership,
  file perms, and the backbone assumptions. Decide before cutover, not after.

### 2. herdr is NOT running, and last died by crashing
- Binary: /usr/local/bin/herdr -> /root/.local/bin/herdr, v0.8.0.
- Full `ps auxww` in WSL and a Win32_Process sweep on Windows: NO herdr process
  anywhere. `ss -lx`: no herdr unix socket listening. /root/.config/herdr/ holds
  config.toml, logs, session state, and LEFTOVER socket files (herdr.sock,
  herdr-client.sock) with no listener behind them.
- journalctl: repeated fatal signal 6 (abort) crashes of herdr on Aug 17 (~21:39 and
  ~21:59), captured by WSL CaptureCrash. Nothing since.
- The task brief said "the running herdr server" -- that premise is FALSE right now.
  Untouched per instructions. W5 plans to make herdr the backbone ExecStart; that
  requires understanding these crashes first (/root/.config/herdr/herdr-server.log
  is the place to look -- not read in this audit beyond confirming existence).

---

## SURPRISE (things not anticipated)

### 1. Today's sessions run the WINDOWS Claude binary through interop
- server.js:1589: proc.write('cmd.exe /c claude\r') into the dtach pty; the comment at
  server.js:194-196 says cmd.exe cannot run under dtach -n directly, so the pty sends
  the claude command. ps in WSL confirms: the cm-0 session contains
  /init /mnt/c/Windows/system32/cmd.exe cmd.exe /c claude.
- Consequence: "sessions inside WSL" today means only the PERSISTENCE (dtach + bash)
  is in WSL. Claude Code itself, its credentials, its ~/.claude config/skills/commands
  (server.js:2227-2260 scans them on the WINDOWS side via os.homedir()), and the repo
  working dirs are all Windows. The migration swaps binary + auth + config/skills +
  working dirs at once -- bigger than "move the Node server", and it explains why the
  WSL claude is stale and unauthenticated.

### 2. /tmp is ext4 but purged at boot and aged at 30 days
- Covered in NEEDS SETUP 2. The non-obvious half: a live, idle session older than 30
  days can lose its socket file to systemd-tmpfiles-clean while still running.

### 3. The distro's default user is root
- Lxss registry DefaultUid=0. The only other human user is `runner` (uid 1000, CI
  pool). Everything claude-mobile touches is root-owned by design.

### 4. The distro is shared CI infrastructure
- 11 enabled GitHub Actions runner services (4x loomi-api, 4x loomi-os, 3x ALE) +
  loomi-runner-heal.timer run in THIS distro, with RunnerService.js processes live
  right now. Any `wsl --shutdown` / `wsl -t Ubuntu-24.04` during migration work also
  takes down the CI runner pool for all three repos. Plan migration steps that restart
  the distro around CI quiet periods.

### 5. Sleep/resume demonstrably disturbs WSL networking on this box
- loomi-runner-heal.service exists specifically to "reconnect after laptop sleep".
  The localhost relay for a WSL-hosted 3456 is in the same class of post-sleep risk.
  No networkingMode is set (default NAT; mirrored NOT enabled); localhostForwarding
  is default-true and nothing pins it. Verified working now; durability across
  reboot/sleep is UNKNOWN-leaning-flaky -- the periodic watchdog (NEEDS SETUP 5) is
  the mitigation, matching the runner-heal precedent.

### 6. IPv6 loopback subtlety at cutover
- The Windows server today listens on ::1:3456 ONLY (netstat: pid 27860, a pm2 fork
  of node). tailscale serve dials localhost:3456 and today lands on ::1. The WSL NAT
  localhost relay is historically IPv4-centric; the prior Windows->WSL HTTP 200 may
  have been over 127.0.0.1. If tailscale's dialer tries ::1 first without falling
  back, remote access breaks while 127.0.0.1 tests pass. VERIFY at cutover: with the
  server in WSL, `tailscale serve status` + a request through the tailnet URL, plus
  explicit curl of http://[::1]:3456 and http://127.0.0.1:3456 from Windows.
  Uncertain, cheap to test, expensive to discover from the phone.

### 7. Minor notes
- WSL DNS: auto-generated resolv.conf, nameserver 10.255.255.254 (DNS tunneling),
  search tail41c424.ts.net -- Tailscale DNS works inside WSL; no proxy env vars seen.
- Interop enabled + appendWindowsPath on (42 /mnt/* PATH entries) -- inside WSL,
  `claude` resolves to /usr/bin/claude (the Linux one) because /usr/bin precedes the
  Windows PATH tail; no shadowing trap.
- docker-desktop distro present but Stopped; /usr/local/bin kubectl + cagent symlinks
  dangle while Docker Desktop is down. Harmless.
- pm2 inside WSL: use `pm2 startup systemd` or a plain systemd unit for the server;
  a bare `pm2 resurrect` from a shell would daemonize outside systemd supervision.
- Windows node 24.13.1 vs WSL node 22.22.1 -- no engines constraint in package.json,
  so not blocking, but build artifacts (node_modules) can NEVER be shared across the
  boundary: node-pty is a native module and must be npm ci-built inside WSL.

---

## Direct answers to the eight questions

1. systemd: YES, enabled and running. Units of interest: claude-mobile-backbone.service
   (active, enabled, documented herdr swap point), 11 actions.runner.* services,
   loomi-runner-heal.timer. Root SYSTEM units survive distro restart (proven); user
   units unused and would need linger (not enabled).
2. Auto-start: LOGON only -- ClaudeMobile-Startup scheduled task (startup.ps1) +
   loomi-runner-keepalive.vbs. Nothing at boot pre-logon. Once started, the backbone
   unit holds the distro up (no .wslconfig vmIdleTimeout override needed in practice).
3. Localhost forwarding: default NAT (no .wslconfig file at all; /etc/wsl.conf has
   only [boot]). mirrored NOT set. Default localhostForwarding=true, unpinned.
   Survives restarts as default behavior; sleep/resume flakiness is documented on
   this very box for the runner class (the heal timer exists because of it). Honest
   verdict: works now, durability unproven, watchdog required.
4. Toolchain: build-essential / gcc 13.3 / g++ 13.3 / make 4.3 / python3 3.12.3 all
   present; node-gyp 11.2.0 via npm bundle. Node v22.22.1 (nodesource), npm 10.9.4.
   No engines field in claude-mobile; deps compatible. node-pty will compile.
5. Claude in WSL: /usr/bin/claude v2.1.78 (npm-global install, stale vs Windows
   2.1.240), NOT authenticated (no .credentials.json; .claude.json has no oauth).
   Operator login = run `claude` in WSL as root, complete OAuth in the browser.
6. Disk: 895G free inside a 1TB vhdx (74.3GB actual file, ~465GiB free on C:). Repos
   are MiB-scale in git; everything fits trivially.
7. Observability: today only (a) the logon-time startup.ps1 (idempotent,
   HTTP-verifying, logging -- the natural periodic watchdog if given a schedule
   trigger), (b) Windows PM2 (process-crash only), (c) health-monitor = Railway cloud
   cron that CANNOT reach the tailnet-only URL. The in-WSL runner-heal timer is a
   pattern to copy but not external.
8. Everything else: see SURPRISE 1-7 (Windows-claude-via-interop, /tmp purge + aging,
   root default user, shared CI distro, sleep flakiness, ::1 subtlety, herdr crashed).
