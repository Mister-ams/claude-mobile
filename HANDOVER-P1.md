# HANDOVER -- P1: session backend seam (herdr on Windows)

Written 2026-08-23 by the orchestrator session. You are executing **P1 only**.
Planning and decisions stay with the orchestrator -- if something here looks
wrong, say so rather than redesigning.

## What you are building, in one paragraph

`claude-mobile` currently persists terminal sessions with `dtach` inside WSL,
reached by spawning `wsl.exe` from a Node server on Windows. We are replacing
that with **herdr running natively on Windows** (ConPTY panes), which removes
WSL from the critical path entirely. P1 puts a herdr session backend **behind a
config flag with dtach as the default**, running on a second port, so the live
service is never the thing being experimented on.

You are NOT deleting dtach. That is P3, after a week of soak.

## State of the world

- Repo: `C:\Users\MRAL-\Projects\claude-mobile`, branch `master` at `f4ff5ab`, v3.4.0, tree clean.
- Live service: PM2 process `claude-mobile` on **port 3456**, serving over Tailscale.
  **Do not touch it.** It holds real work.
- herdr: **v0.8.2 at `C:\Users\MRAL-\tools\herdr\herdr.exe`**. Keep the directory
  intact -- the ConPTY runtime (`conpty\`) must sit beside the exe.
- herdr's Claude integration is installed: hook v8 at
  `C:\Users\MRAL-\.claude\hooks\herdr-agent-state.ps1`, plus one `SessionStart`
  entry in `~/.claude/settings.json`. Backup of both settings files is at
  `...\scratchpad\claude-config-backup\`.

## P0 results -- do not re-litigate these

All proven on this machine, 2026-08-22/23:

| Finding | Evidence |
|---|---|
| node-pty CAN host herdr.exe under ConPTY | alt-screen switch, 57 box glyphs, input accepted |
| herdr detects Claude on Windows | `agent: claude`, `pane_id: w1:p1`, in **6 seconds** |
| herdr server persists after its client dies | `status: running` with no client attached |
| Cursor is stable through our renderer | 60 idle samples: 0 moves, 0 oscillations; DOM cursor 0.7px from snapshot column |
| herdr panes are **alt-screen**, so `baseY=0` | no scrollback -- snapshots are viewport-only, ~32 rows |

Working probe scripts, if you want to re-run any of it:
`...\scratchpad\p04-decider.js`, `p03-agent.js`, `p05-cursor.js`, `p05-render.py`.

## The seam

All dtach coupling lives in a small, contiguous surface. Put a herdr
implementation beside it, selected by config -- the same shape as
`RENDERER_MODE` already selecting grid vs xterm.

```
server.js:151  wslRun / wslBash          <- WSL transport, herdr needs none
server.js:176  dtachSocket(id)
server.js:197  createDtachDaemon(id,dir) <- herdr: create a pane
server.js:205  attachToDtach(id,c,r)     <- herdr: node-pty spawn herdr.exe
server.js:225  dtachSocketState(socket)
server.js:233  dtachSessionAlive(id)
server.js:252  killDtachSession(id)
server.js:1558 createSession(...)
server.js:1589 proc.write('cmd.exe /c claude\r')  <- herdr: 'claude\r', no interop
server.js:1607 recoverDtachSessions()    <- herdr: enumerate panes via the API
```

Constants the backend owns: `DTACH_DIR` (92), `DTACH_PREFIX` (93),
`WSL_DISTRO` (91).

## Tasks

**P1.1 -- extract the seam.** A `sessionBackend` module with both
implementations behind one interface. Config selects; **default stays dtach**.

**P1.2 -- second instance on 3457 with the herdr backend.** 3456 keeps running
dtach, untouched.

**P1.3 -- verify with the iPad emulator.** `test/ipad-emulator.py` already
exists and drives four viewports. Point it at 3457. **Do this before asking the
operator to look at anything** -- he must never be the first live tester.

**P1.4 -- survive a server restart.** `pm2 restart`, confirm sessions recover.
This is dtach's core value (236 restarts over five months); herdr has to match
it before it can replace it.

### Acceptance
3457 serves a herdr-backed session that survives a restart, the emulator passes
on all four viewports, and backing out is a config flag rather than a revert.

## Gotchas that will bite you

**1. A second server will STEAL the live sessions.** `DTACH_DIR` is hardcoded
`/tmp` and recovery scans `cm-*`. This already happened once in a previous
session -- a test server on another port adopted `cm-0`. If your 3457 instance
ever runs the dtach backend, give it a different prefix. Verify socket ownership
with `lsof`, do not assume.

**2. `npm ci` while PM2 holds node-pty half-deletes `node_modules`.** npm wipes
alphabetically; `node-pty` has a native `.node` binary the live server holds
open, so the wipe dies partway and everything before it vanishes -- invisibly,
until the next restart. Always `pm2 stop` -> `npm ci` -> `pm2 restart`.

**3. node-pty's ConPTY kill path throws `AttachConsole failed`.** Killing a
ConPTY-hosted TUI crashes `conpty_console_list_agent.js`. Workaround used in P0:
stop the herdr server via its CLI and let the client fall out, rather than
`proc.kill()`. Session close needs to handle this properly.

**4. Column negotiation.** herdr panes need sizing to the client's cols, exactly
as dtach sessions do. P0's harness captured 120 cols and rendered into 102 --
harmless there, real in production.

**5. Session identity / resume is UNVERIFIED.** `HERDR_ENV` and `HERDR_PANE_ID`
were not observed in the pane, and the hook exits early without them. Detection
works via screen-manifest scraping, not the hook. If resume matters to a task,
prove it rather than assuming.

**6. Python on this box defaults to cp1252.** Pass `encoding="utf-8"` when
reading anything with box-drawing glyphs. Python is at
`C:\Users\MRAL-\AppData\Local\Python\bin\python.exe`.

**7. Git Bash `/tmp` is not WSL's `/tmp`.** Not that you need WSL for P1.

## House rules

- **Never commit or push to `master`.** PR-only; 4 required checks
  (`ci`, `Semgrep`, `secret-scan`, `osv-scan`). Rebase, never merge master in.
- Run the local gate before pushing: `node --check`, `npm run verify:asset-version`,
  `npm audit --audit-level=high`.
- **Only the operator merges.** Do not merge, even when CI is green.
- Never dark mode; light theme. ASCII only in docs.
- A fix is done when the original artifact is re-exercised and observed passing.
  Green CI is not done.

## Do not

- Delete dtach, the `wsl.exe` layer, or the interop launch. That is P3.
- Touch port 3456, its PM2 process, or its sessions.
- Change the default backend. P1 ships with dtach default and herdr opt-in.
- Re-run the herdr integration install -- it is already current at v8.

## Open questions for the orchestrator

Report back rather than deciding:

- Whether the herdr backend should keep one pane per session or use herdr's own
  tabs/workspaces (affects whether our session list or herdr's is canonical).
- Whether to keep `MAX_SESSIONS = 8` under herdr.
- Anything where herdr's model and ours disagree structurally.

## Reference

- Plan: `...\scratchpad\windows-native-plan.html`
- Live tracker: `...\scratchpad\windows-native-tracker.html`
- Architecture as-built: `...\scratchpad\claude-mobile-architecture.html`
- Decision record incl. the superseded WSL route:
  `...\scratchpad\wsl-architecture-decision.html`

(`...` = `C:\Users\MRAL-\AppData\Local\Temp\claude\C--Users-MRAL--Projects-loomi-os\21e25eab-3c6b-4ec6-a7b9-19ec052bb419`)
