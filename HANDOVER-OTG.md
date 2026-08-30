# HANDOVER -- OTG orchestrator thread

Generated: 2026-08-30

Read this, then `.planning/windows-native-tracker.html` -- **open items are at the
top of it now, the record below**. `HANDOVER-P1.md` is the retired P1 executor brief.

## Where we are

`claude-mobile` v3.6.0. **3456 runs herdr natively on Windows. WSL is off the
session path.** 17 of 26 tasks done; the P2.2 soak week started 29 Aug 18:55 and
is the only open item that needs the operator.

## Decisions

- **Flip the instance the operator already uses, rather than expose the second
  one.** 3457 needed a tailnet route, a second TOTP enrolment and had no
  passkeys; 3456 already had all of it plus the only `dump.pm2` entry, so
  reboot survival came free. Collapsed a four-item plan to one. [verified]
- **P3.1 moved AHEAD of P2.2.** The plan had the flip after the soak, which
  cannot work: the flip is what makes the week possible. [verified]
- **P3.1 was mis-scoped as "flip the flag".** 3456 ran 3.5.0, so it was really
  deploy-then-flip -- and a `git pull` in the live checkout IS the deploy. [verified]
- **A deliberate stop is not an abort.** The crash watch reports `vanished`
  separately from `crash`; nothing at that layer can tell them apart, and
  condemning a week because the operator restarted something is worse than
  saying plainly what was seen. It still blocks a "clean" verdict. [verified]
- **Coverage is reported before the crash count.** A crash count of zero means
  nothing without it -- that misreading is what voided the previous four days. [verified]

## State Changes

- #20 (f65a491) T22 mouse reporting; #21 (5fa0cc5) P2.1 crash watch; #22
  (ad63470) tracker. All re-verified against master, not their branches. [verified]
- 3456: v3.6.0, `sessionBackend: herdr`, session `cm-0`, tailnet serving
  `app.js?v=3.6.0`, `MOUSE: cm-0 tracking=any encoding=sgr` in the audit log. [verified]
- Crash watch running under PM2; `pm2 save` now carries bridge + watch. [verified]
- 3457 retired (both halves), `cm-wt-p1`/`cm-wt-ctl`/`cm-wt-fix` worktrees and
  their live TOTP secrets removed. One instance, one session, one worktree. [verified]

## Discovered Constraints

- **herdr sends `CSI ?1003;1006h` COMBINED.** A handler reading one parameter
  captures the encoding as default and spells SGR in byte form -- wrong cells
  past column 95, nothing past 223. [verified]
- **`setPointerCapture` retargets to the wrap**, so `closest('.grid-row')` is
  null for a whole drag -- the gesture herdr uses to resize a split. Clicks were
  unaffected, which is why every test passed. Resolve cells geometrically. [verified]
- **A junction is not a copy, and a recursive delete does not know that.**
  `Remove-Item -Recurse` followed `node_modules` into the live checkout: 115
  entries to 48, node-pty gone, `/health` still `ok`. Unlink first (`rmdir`, or
  `Directory.Delete(path,false)`), or give a throwaway its own install. [verified]
- **`pm2 delete` strands the herdr session.** Held twice now (`cmc-0`, `cmh-0`).
  Always `session stop` + `session delete` after. [verified]
- Resume works: hook fires -> real session id -> `claude --resume <uuid>`
  returns the conversation. dtach cannot do this. [verified]

## Next Action

Nothing is blocked. **Use it from the iPad** -- that is P2.2, and the only
unverified link is the operator's first tap (the browser-to-pane path is proven
12/12 on identical code but never on 3456, which needs their TOTP). Read the
soak any time with `npm run watch:summary`; a window with poor coverage refuses
to read as clean. At week's end, the go/no-go clears P3.2 and P3.3.

Rollback stays one line: delete `sessionBackend`, restart. `dtach pid 678`
still holds `/tmp/cm-0.dtach`, so flipping back reattaches the ORIGINAL session.

## Context Pointers

- `.planning/windows-native-tracker.html` -- open items first, then the record.
- `scripts/crash-watch.js` + `ecosystem.crash-watch.config.js` -- the soak watch.
- `lib/mouse.js` -- DEC mode capture + event encoding, testable without a server.
- `test/t22-client-click-verify.py` -- the browser-to-pane proof; needs a TOTP.
- `test/crash-watch-live-verify.js` -- watches the detector fire; skips LOUD
  (exit 2) rather than green if node-pty is missing.
