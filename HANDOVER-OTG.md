# HANDOVER -- OTG orchestrator thread

Written 2026-08-25 by session CLAUDE-OTG. Read this first, then
`.planning/windows-native-tracker.html` for live task status.

This is the ORCHESTRATOR handover -- planning, decisions, and what to do next.
`HANDOVER-P1.md` was the executor brief for P1 and is now history.

## Where we are

`claude-mobile` v3.5.0. **P0 and P1 complete, 10 of 21 tasks. P2 (soak) is next.**

We are replacing `dtach`-in-WSL with **herdr running natively on Windows**, which
takes WSL off the critical path entirely. herdr is behind a config flag with
dtach still the default; nothing is deleted until a week of soak says so.

## How we got here (the short version)

The original 2026-08-16 spike said NO-GO on herdr, partly because "v0.8.0 ships
no Windows binary". **That fact expired.** v0.8.2 ships one, the server runs
natively on Windows with ConPTY panes, and it detects Claude Code there. That
single release note obsoleted a WSL migration plan we had almost committed to.

Lesson worth keeping: **when a decision rests on a version-pinned fact, the
decision expires with the version.** Re-check release assets before building on
a vendor limitation.

Superseded routes, kept for reasoning: `.planning/wsl-architecture-decision.html`
(four architectures compared, with the measurements) and
`.planning/windows-native-plan.html` (the phase plan).

## The measurements that decided it

| Measured | Result |
|---|---|
| Linux reading Windows files over `/mnt/c` | **373x** slower on metadata, 48x on content |
| Windows reading Linux files over `\\wsl$` | **7.5x** -- the penalty is NOT symmetric |
| Point reads over `/mnt/c` | ~13ms each; fine for configs and secrets |
| Claude reading NTFS natively from Windows | 119ms/2,016 files |

The asymmetry is the whole finding: it vindicates keeping Claude on Windows, and
it means `.loomi-config` never needs copying anywhere -- it is a point read.

## What P0 and P1 proved

- node-pty CAN host `herdr.exe` under ConPTY; alt-screen, box drawing, input all fine.
- herdr detects Claude on Windows in **6 seconds**.
- herdr's server persists after its client dies.
- Cursor is stable through our renderer: 60 idle samples, 0 moves, 0 oscillations, DOM cursor 0.7px from the snapshot column.
- herdr panes are **alt-screen**, so `baseY=0` -- no scrollback, snapshots are viewport-only.
- Session survives `pm2 restart` -- **observed**, identical `terminal_id` across it.

P1 also fixed two real bugs found by extracting the seam: a transient WSL hiccup
could delete a live session, and a non-default prefix lost every session name on
restart then persisted the loss.

## Do this before P2 opens

1. **Prune to one instance -- BOTH halves, or you strand a session.**
   `pm2 delete` does NOT stop the herdr session. The herdr server is
   deliberately not a child of the node process -- that orphaning is exactly
   what makes sessions survive `pm2 restart` -- so deleting the PM2 process
   leaves an orphaned herdr server and its Claude session running forever with
   nothing supervising it. Verified: `herdr session list` currently shows
   `cmc-0` and `cmh-0` both `running`, each on its own socket.

   ```
   pm2 delete claude-mobile-ctl
   herdr session stop cmc-0 && herdr session delete cmc-0
   herdr session list          # confirm; a stopped-but-not-deleted record
                               # persists and blocks reusing the name
   ```

   The same applies whenever 3457 is retired -- stop `cmh-0` explicitly.
   Disposable alongside it: the `cm-wt-ctl` and `cm-wt-fix` worktrees, and the
   dead `.claude-mobile-ctl-audit.log` / `-dtach-audit.log` in the home
   directory (the `auditPath` knob exists so a second instance cannot interleave
   writes into the live server's trail).

   **Secret hygiene:** each test instance minted its OWN TOTP secret via its
   localhost `/setup` -- the operator's was never copied -- but
   `.totp-secret` and `.server-identity-key` in `cm-wt-p1` and `cm-wt-ctl` are
   real credentials with a lifetime. They should die with the worktrees. Both
   instances bind localhost only and `tailscale serve` fronts 3456 alone, so
   nothing was tailnet-reachable.
2. **Chase the resume lead -- about ten minutes.** `herdr api snapshot` reports
   `agent_session {kind:"id", source:"herdr:claude", value:<uuid>}` on our pane.
   `pane report-agent-session` is exactly what the SessionStart hook calls, so
   the hook may be firing after all -- which would contradict the P0 conclusion
   that detection is screen-scraping only, and would mean resume already works.
   `herdr pane get` plus the hook log settles it.

## Open, and needing the operator

- **3456's FIRST update runs the OLD `update.sh`** -- the buggy one -- and that
  update changes the manifest, so it takes the `npm ci` path. **Do it from the
  laptop with the process stopped, once.** Do not tap Update on 3456 from the iPad.
- **Restart signs every client out** (tokens are an in-memory Map). Whether to
  persist tokens across restarts is a security-posture decision.
- **`MAX_SESSIONS = 8` is unmeasured under herdr.** Eight sessions means eight
  herdr servers plus eight node-pty clients, uncounted in our footprint.

## Known unresolved

- **Session identity / resume: UNVERIFIED.** PR #15's env whitelist runs the
  opposite direction -- it stops the server's env leaking INTO the pane (a stray
  `CLAUDE_CODE_CHILD_SESSION` was disabling transcript saving). It says nothing
  about herdr injecting `HERDR_ENV` / `HERDR_PANE_ID`. See the lead above.
- **herdr stability is the real risk and P0/P1 did not retire it.** 45
  crash-shaped lines and repeated SIGABRT on Linux, 17 August. Windows is a
  different build so the number transfers nothing either way. Only P2 answers it.
  dtach is the incumbent: 236 restarts over five months, zero aborts.
- **The `npm ci` path has no automated coverage.** Both arms measured by hand.
- **Three guards in `update.sh` are verified as primitives, not in situ** --
  self-flagged by OTG-P1 against the "have I watched it fail?" standard, and
  worth honouring rather than filing away. The `CM_SERVER_PID` guard (refuses to
  install while the server that asked is still alive) has **never fired in a
  real update**, because `pm2 stop` has always succeeded. The primitive was
  proven both ways in isolation -- and that mattered: `kill -0` could not see a
  Windows pid at all and would have made the guard silently inert, so it uses
  `tasklist`. The `pm2 start` fallback in the trap, and the restart block, are
  likewise unexercised. The sibling paths WERE exercised for real: the trap, by
  killing a script mid-update and watching the server return with its session;
  and the broken-tree refusal, against a tree with no `node_modules`. Closing
  the remaining three needs the same local-origin harness as the `npm ci` gap.
- `newSession()` sends `rows=200` on create, so every pty is briefly 200 rows.
  Harmless under dtach; it made a sizing guard inert once.

## Structural mismatches between herdr's model and ours

1. Panes are alt-screen -- rows scrolling off never reach host scrollback, so our
   400KB ring has nothing to capture beyond the viewport.
2. herdr is mouse-first and requests mouse tracking; our client sends no mouse
   events, so every click in a pane is inert. This is almost certainly why herdr
   felt bad on the iPad. T22 is now a prerequisite, not a nice-to-have.
3. The pty hosts the herdr CLIENT, so the phone renders herdr's whole TUI
   including chrome. Suppressed via our own `herdr-config.toml` through
   `HERDR_CONFIG_PATH` -- worth 27 columns at iPad width.
4. At phone width herdr shows a compact top rail the `[ui]` settings do not
   suppress. Left alone; phone is deprioritised.

## The pattern to carry into P2

From OTG-P1, and it cost most of P1's time:

> This system fails by reporting success.

An `npm ci` exited 0 while deleting 112 of 115 packages, with `/health` still
answering 200 and a live session attached. A guard that could not fire. A poll
that could never succeed. Green CI, `ok:true` and a written state file all
agreeing while the update had failed. None of it was found by reading code.

**Watch the soak for outcomes, not for absence of errors.**

## Environment

- herdr v0.8.2 at `C:\Users\MRAL-\tools\herdr\herdr.exe` -- keep `conpty\` beside it.
- Integration hook v8 at `C:\Users\MRAL-\.claude\hooks\herdr-agent-state.ps1`,
  one `SessionStart` entry in `~/.claude/settings.json`. No-ops outside herdr.
- Instances: **3456** live (dtach, v3.4.0, do not touch) · **3457** soak
  (herdr, worktree `cm-wt-p1`) · **3459** disposable.
- Harnesses: `test/live-session-verify.py` (real login, real session, asserts
  which backend answered) and `test/ipad-emulator.py` (static client only --
  it cannot test a backend).

## House rules

PR-only to `master`, 4 required checks, rebase never merge. Only the operator
merges. Never dark mode. ASCII in docs. A fix is done when the original artifact
is re-exercised and observed passing -- green CI is not done.
