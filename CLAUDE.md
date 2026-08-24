# CLAUDE.md -- Project OTG (On-The-Go)

Claude Mobile Bridge -- mobile web interface for Claude Code terminal sessions over Tailscale VPN.

## Architecture

```
claude-mobile/                    v3.2.18
├── server.js                     Node.js: Express + WebSocket + node-pty + session backend + E2E crypto
├── lib/server-control.js         Restart + update this process, from the client
├── lib/orphan-spawn.js           Spawn something PM2's tree-kill cannot reach
├── scripts/update-runner.js      Runs update.sh from outside the server's life
├── lib/session-backend/          Session persistence, one module per backend
│   ├── index.js                  The contract + `sessionBackend` selection (default dtach)
│   ├── dtach.js                  dtach daemons inside WSL (shipped default)
│   └── herdr.js                  herdr named sessions, native Windows ConPTY
├── herdr-config.toml             herdr config for OUR sessions only (never the operator's)
├── config.json                   Projects, autoStart, tailscaleHostname, port (gitignored)
├── config.example.json           Template for config.json
├── config.herdr.example.json     Template for a SECOND instance on the herdr backend
├── install.sh                    Full setup script (WSL, dtach, PM2, Tailscale serve)
├── update.sh                     Pull + deps + PM2 restart
├── public/
│   ├── index.html                Mobile web UI (xterm.js, custom input, Palantir theme, merged #auth-screen)
│   ├── setup.html                Setup pages (TOTP config, extracted from server.js in T08)
│   ├── style.css                 Extracted CSS (503 lines) -- layout, themes, animations
│   ├── vendor/                   Bundled xterm.js + addons (no CDN)
│   └── apple-touch-icon.png      PWA icon
├── test/live-session-verify.py   E2E against a RUNNING server: real auth, real session, 4 viewports
├── test/herdr-pane-geometry.py   herdr-only: does a resize reach the PANE, not just our mirror
├── test/server-control-verify.py Drives the Restart/Update buttons against a live server
├── package.json                  Deps: express, ws, node-pty, @simplewebauthn/server, otpauth, qrcode
└── .gitignore                    node_modules/, config.json, .totp-secret, .credentials.json, .server-identity-key
```

## How it works

- Claude Code runs inside a **session backend** chosen by `sessionBackend` in config.json.
  `dtach` (default) runs it in a dtach daemon inside WSL Ubuntu-24.04; `herdr` runs it in a
  herdr named session natively on Windows, no WSL at all. Both survive server restarts.
  Everything above the backend -- WebSocket, scrollback ring, headless mirror, attention
  detection, auth -- is identical either way
- dtach detaches/reattaches pty sessions without terminal emulation -- xterm.js gets raw pty output
- node-pty spawns `wsl.exe` to attach to dtach sessions; raw ANSI streams over WebSocket to xterm.js
- Server-side 400KB ring buffer (`session.scrollback`) captures all pty output for history replay
- On reconnect, server sends buffer to client; client uses `term.reset()` + chunked writes (50 lines/batch)
- Tailscale VPN provides zero-public-surface networking; `tailscale serve` proxies HTTPS -> localhost:3456
- PM2 manages the daemon; dtach sessions survive PM2/node restarts (live in WSL as socket files)
- Server control lives in the settings panel: **Restart** and **Update** (pull, install if the
  manifests moved, restart). There is no stop and no start -- the UI is served BY this process,
  so a stop is a one-way door and a start could never work. Both are auth-gated exactly like
  every other write route, and confirm with a two-step tap rather than `confirm()`
- Attention detection (5s debounce) triggers Web Notifications + vibration on permission prompts, questions, idle prompt
- GPU-accelerated rendering: WebGL -> Canvas -> DOM fallback chain (v3.0.2)
- Slash command discovery: scans skills/ + commands/ directories (v3.0.1)

## Security (4-tier)

- **P0**: IP-bound session tokens (30-min TTL, auto-rotated via WebSocket). Per-IP + global rate limiting.
- **P1**: Ephemeral ECDH P-256 + AES-256-GCM per WebSocket. Counter-based IV. Anti-downgrade enforcement.
- **P2**: TOFU key pinning -- server P-256 identity key, ECDSA signature binding ephemeral keys.
- **P3**: CSP headers + configurable inactivity lock (default 15min). 8h auto-shutdown.
- Auth: TOTP (Apple Passwords) primary, WebAuthn passkeys (Face ID) secondary. Setup via localhost-only `/setup` page.
- WebAuthn rpID = `config.json` tailscaleHostname (Tailscale MagicDNS hostname).

## Key decisions

- xterm.js `disableStdin: true` -- all input via textarea, avoids iOS keyboard bugs
- `interactive-widget=resizes-content` in viewport meta -- iOS manages keyboard natively, no JS height management
- Terminal refits on WIDTH change only (orientation). Height changes: zero JS interaction with xterm.js
- dtach for process persistence -- no terminal emulation layer, no alternate screen issues
- Session backends are a config flag, not a fork: `sessionBackend` selects, dtach stays the
  default, and backing out of an experiment is an edit rather than a revert. Same shape as
  `RENDERER_MODE` selecting grid vs xterm
- `state()` on a backend is four-valued (`alive`/`stale`/`gone`/`unknown`), never a boolean.
  "the backend could not be asked" is not "the session is dead", and collapsing them drops
  live sessions on a transient WSL or herdr hiccup
- `session.scrollback` (400KB ring buffer) replaces tmux capture-pane for history replay
- Chunked scrollback writes (50-line batches via term.write callback) prevent xterm.js parser corruption
- Claude launched via `cmd.exe /c claude` (Windows interop from WSL) -- uses existing Windows auth
- Sessions created at phone's column width (client sends cols/rows on create)
- No bracketed paste -- Claude Code TUI ignores \r after paste sequences; send plain text + \r
- Image upload via zero-size absolute file input (not display:none) for iOS compatibility

## Launch

```bash
pm2 start server.js --name claude-mobile    # start daemon
pm2 logs claude-mobile                       # view logs
bash update.sh                               # pull + restart
```

Setup: open `http://localhost:3456/setup` on laptop to configure TOTP.

### A second instance (backend experiments)

Never in the live checkout -- PM2 is running `server.js` from there, so a checkout swaps the
live server's code under it. Use a worktree, and give it `config.herdr.example.json`:

```bash
git worktree add -b <branch> ../cm-wt-x origin/master
cp -r node_modules ../cm-wt-x/           # NOT npm ci -- see the node-pty gotcha
cp config.herdr.example.json ../cm-wt-x/config.json   # then edit port/prefix/paths
cd ../cm-wt-x && pm2 start server.js --name claude-mobile-<x>
```

It mints its own TOTP secret at `http://localhost:<port>/setup` -- never copy the live one.

Verify it end to end before anyone looks at it:

```bash
python.exe test/live-session-verify.py --port <port> --totp-secret <base32> \
           --expect-backend herdr --restart-pm2 claude-mobile-<x>
```

That asserts which backend is actually running -- without it a green run proves only that
SOME backend works -- then authenticates for real, creates a session, waits for Claude to
paint, restarts the process, and requires the SAME session back: id, name and directory,
not a count. It also rotates each iPad viewport and requires the server's dimensions to
catch up with the client's (`--no-rotate` skips it).

`test/ipad-emulator.py` cannot do any of that: it drives a static server with synthetic
frames and never reaches a backend. Use it for pure-client regressions, this for anything
below them.

Rotation converging proves the client and the server agree. It does NOT prove the backend's
pane followed -- the server resizes its own mirror when asked, either way, so a backend that
ignored resize entirely would still converge. For herdr, confirm the far end separately,
through herdr's own API:

```bash
python.exe test/herdr-pane-geometry.py --port PORT --totp-secret BASE32
```

## Gotchas

- No JS should change `appEl.style.height` or call `scrollToBottom` on resize events
- `doResize()` must check `proposeDimensions()` before `fit()` -- skip if cols/rows unchanged
- WSL Ubuntu-24.04 must be running for dtach sessions to work
- **A restart signs every client out.** Claude sessions survive it -- that is the backend's
  whole job -- but session TOKENS live in an in-memory Map, so every client re-authenticates.
  The Restart button says so before the tap. Anything polling across a restart must ask
  liveness UNAUTHENTICATED (`/health`), or it reports "the server never came back" about a
  server that came back fine
- **npm ci while the server runs half-deletes node_modules**, and it looks like success. npm
  wipes alphabetically and the live server holds node-pty native binary open, so the wipe dies
  partway. Observed 24 Aug 2026 on the first real update: 115 entries down to 3, require of
  node-pty threw, and /health still answered 200 with a live session -- the next restart would
  have been a dead server. update.sh now stops the PM2 process before installing, verifies
  node-pty loads afterwards, and REPAIRS rather than reports if it does not -- the server is
  already stopped at that point, which is the condition under which the install works. If it
  cannot stop the process it skips the install entirely: a tree one version behind still runs,
  a half-deleted one does not. A trap restores the process on every exit path, including an
  abort under `set -e`. An instance still on a pre-fix update.sh gets one more exposure on its
  next dependency-changing update -- the OLD script performs that one -- so run it from the
  laptop with the process stopped
- **MSYS bash cannot use an inherited raw fd** for stdout/stderr from a native Windows
  process. `stdio: ['ignore', fd, fd]` makes it exit 1 after ~1.7s having written nothing at
  all -- no error, an empty log, a bare failure code. Pipe and write the file yourself.
  Measured: fd -> exit 1 / 0 bytes, pipe -> exit 0 / 2597 bytes
- `update.sh` restarts `$CM_PM2_NAME` (default `claude-mobile`). It used to hardcode the name
  behind a SUBSTRING guard, so an update run from a second instance restarted the LIVE server
- `sessionPrefix` is what keeps two instances apart. Recovery scans the PREFIX, not the port,
  so a second server sharing a prefix ADOPTS the first one's sessions -- this has happened.
  Any instance that is not the live service gets its own prefix (and its own `auditPath`)
- herdr: `detached: true` does NOT survive `pm2 restart` on Windows. It stops the child dying
  WITH the parent but leaves the parent-PID record, and PM2 tree-kills (`taskkill /T`). The
  herdr server is therefore launched through a throwaway node process that exits immediately,
  so it is an orphan before PM2 ever enumerates our descendants. Measured both ways
- herdr panes are alternate-screen, so there is no host scrollback to recover -- snapshots are
  viewport-only. `pane read --lines N` cannot reach rows that left the alternate screen
- node-pty's ConPTY kill path spawns a console-list helper that dies with `AttachConsole
  failed`. Stop a herdr session via its CLI and let the client fall out; killing the pty first
  is the noisy path
- dtach sessions use socket files at `/tmp/cm-{id}.dtach` -- do not manually create with that prefix
- After PM2 restart, scrollback buffer starts empty and rebuilds from live output
- `.session-meta.json` persists session names across restarts
- config.json is gitignored; config.example.json is the template
- Port 3456 must be free (PM2 manages lifecycle; `pm2 stop claude-mobile` to free it)
- Passkeys must be re-registered if tailscaleHostname changes (rpID binding)
- Text and Enter must be sent as single atomic pty write (qsend(t + '\r')) -- separate writes race in the pipeline
- iOS Safari serves stale HTML across `pm2 restart` despite `Cache-Control: no-cache, no-store, must-revalidate`. Tab close + reopen busts it; in-tab reload sometimes does not
- iOS Safari probes fallback char metrics if SF Mono / Menlo has not resolved at measurement time -- 7.13px instead of 7.81px, a 5-col over-estimate. The `document.fonts.ready` callback corrects it
- Multi-client PTY resize race: clients on the same session each send their own resize, last writer wins. `doResize` must compare against `grid.cols` (snapshot ground truth), never a local `lastCols` cache
- `touch-action: pan-y` is required on scroll containers under iOS; `auto` lets iOS evaluate horizontal pans first and breaks JS swipe handlers
- ResizeObserver is the cheapest signal for "session became visible after being switched away" -- catches the display:none -> block transition that snapshots arriving while hidden mis-render against (clientHeight=0)

## Renderer

Default is the cell-grid renderer (W6 T24 cutover at 3.2.18, 2026-05-04). Server-side `@xterm/headless` v6.0.0 mirror diffs against last-emitted state; ships row changes (RLE-collapsed `CellRun[]`) over WS as `snapshot` (full state) and `frame` (changed rows). Client (`gridTerms{}`) maintains a virtualized DOM with bounded mount window via spacers. Cursor renders as a 2px absolute-positioned bar tracked from snapshot/frame `cursor` field.

Legacy xterm.js path retained as **opt-out fallback**: `?renderer=xterm` in URL forces it. Used by clients hitting any unforeseen grid-mode issue. T26-T28 (delete legacy server scrollback handler, drop xterm.js vendor bundle, sweep this file) are intentionally held to keep the fallback shipped.

Per-WS `gridRenderer` flag set from the `connect` message's `renderer` field (`server.js:1638`). All four client-side `connect` senders MUST include `renderer: RENDERER_MODE` -- missing it bricks history rendering on the affected WS. See `memory/project_w6_history_render_bug.md`.

## Current State

v3.5.0. Grid renderer is default; xterm fallback retained via `?renderer=xterm`.
Session backend is dtach by default; herdr ships behind the flag, unproven in daily use.

Current state, open items, the herdr evaluation and the security assessment live in the
auto-memory project file `project_otg.md` -- that is the single pointer, kept outside this repo.

Repo-local references: `memory/project_w6_history_render_bug.md` (grid-cutover post-mortem),
`guide-tui-rendering-references.md` (OpenTUI + CLI rendering analysis), `README.md` (install + run).
