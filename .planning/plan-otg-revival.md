---
project: claude-mobile
type: plan
status: active
created: 2026-08-16
updated: 2026-08-16
source: .planning/decision-claude-mobile-herdr-2026-08-16.html
inherited_from: none
---

# Plan: OTG Revival -- Security, iPad Client, herdr Backbone

38 tasks across 7 waves. Single-developer linear execution, except W2 which
runs in parallel with W1.

Baseline: **v3.2.18** (`d000058`, 2026-05-05), local == origin/master.
**Nothing is currently running** -- port 3456 empty, no PM2 process, zero
dtach sockets. A reboot since May took the stack down and nothing resurrects
it. "Revival" is literal.

Version strategy on the existing patch-line discipline:

| Wave | Version | Why |
|------|---------|-----|
| W0 | 3.2.19 | Security hotfix + boot resilience (patch) |
| W1 | none | Spike, no shipped code |
| W2 | 3.3.0 | iPad client (minor -- new capability) |
| W3 | 3.3.1 | Security tier 2 (patch) |
| W4 | 3.3.2 | E2E decision (patch) |
| W5 | 4.0.0 | herdr backbone (major -- architecture change) |
| W6 | 4.0.1 | Cleanup + artifacts |

Findings cited as `R1..R8`, `C1..C6`, `A2`, `N1` and decisions as `D1..D6`
from `decision-claude-mobile-herdr-2026-08-16.html`.

**Gate rule:** every wave lands via PR with the Codex diff-vs-objective judge
pass after CI green and before merge approval, per
`~/.claude/rules/pr-judge-gate.md`. Merge is operator-approved, always.

---

## Wave 0 -- Security hotfix + revival (3.2.19)

No design needed; every item is a known, specific fix. **T02 ships first and
alone** -- it is a live remote-code path in the default renderer and should
not wait behind the rest of the wave.

### T01: Emergency fix -- OSC-8 scheme allowlist (R1)
- Domain: frontend | Action: modify | Risk: low | Effort: small
- Files: `public/index.html:1002-1019` (`renderRow`)
- Depends on: none
- Implementation: before `el.href = run.sgr.hyperlink`, parse the value and
  accept ONLY `https:`, `http:`, `mailto:`. Anything else (notably
  `javascript:`, `data:`, `vbscript:`) renders as a plain `<span>` with the
  same `textContent` and SGR styling. Parse with `new URL(v, location.href)`
  inside a try/catch and test `u.protocol`; do not regex the raw string.
- Verification: **live, not reasoning.** Emit a crafted OSC-8 sequence with a
  `javascript:` target into a session
  (`printf '\e]8;;javascript:alert(1)\e\\click\e]8;;\e\\\n'`) and confirm in
  Safari DevTools that the element is a `<span>`, not an `<a>`; then repeat
  with `https://example.com` and confirm it IS an anchor and still opens.
- Findings: R1 | Behavior: [XSS closed]
- **Ships as its own PR + release. Do not batch.**

### T02: Version bump 3.2.18 -> 3.2.19
- Domain: config | Action: modify | Risk: low | Effort: small
- Files: `package.json`
- Depends on: T01
- Verification: `grep '"version": "3.2.19"' package.json` exits 0

### T03: Extract inline client JS to an external file
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html:113-2210` -> new `public/app.js`
- Depends on: T01
- Implementation: move the single ~2,098-line inline `<script>` block to
  `public/app.js`, loaded as
  `<script src="/app.js?v=<version>"></script>`. The version query is
  **required** -- `HANDOVER.md:22` records iOS Safari serving stale HTML
  across `pm2 restart`, and a separate JS file gets its own cache lifetime,
  so without busting it staleness gets worse, not better. Read the version
  from `package.json` at server start and template it into the served HTML.
- Verification: page loads and a session streams normally on desktop + iPad;
  hard-reload after a version bump serves the new file (check the query
  string in the Network tab).
- Findings: prerequisite for T04 | Behavior: [none]
- Risk note: this is the largest mechanical change in W0. It also SIMPLIFIES
  CI (T07) by removing the regex-extract-inline-script hack.

### T04: CSP tightening
- Domain: api | Action: modify | Risk: medium | Effort: small
- Files: `server.js:588-604`
- Depends on: T03
- Implementation: drop `'unsafe-inline'` from `script-src` (possible only
  after T03); narrow `connect-src` from `'self' ws: wss:` to `'self'` --
  the wildcard is an open exfiltration channel and the client only ever
  connects to its own origin. Keep `'unsafe-inline'` on `style-src` if the
  grid renderer sets inline styles (verify: `applySgr` does), or move to CSS
  custom properties in a later wave.
- Verification: load the app with DevTools console open; zero CSP violation
  reports during login, session create, stream, resize, and image upload.
- Findings: R1 (defense in depth) | Behavior: [none]

### T05: Lock down secret file permissions (R4)
- Domain: infra | Action: modify | Risk: low | Effort: small
- Files: `install.sh`, `update.sh`, plus a one-time manual run
- Depends on: none
- Implementation: `icacls <file> /inheritance:r /grant:r "%USERNAME%":F` for
  `.totp-secret`, `.server-identity-key`, `.credentials.json`, and
  `~/.claude-mobile-audit.log`. Add to both scripts so a fresh install is
  correct, and run once now against the live files. Currently
  `CodexSandboxUsers` holds Modify on all of them -- same class as the
  loomi-api `.loomi-config` finding.
- Verification: `icacls .server-identity-key` lists only the owner, SYSTEM,
  and Administrators. No `CodexSandboxUsers`, no unresolved SID.
- Findings: R4 | Behavior: [none]

### T06: Stop logging terminal content + rotate the audit log (R-LOG)
- Domain: api | Action: modify | Risk: low | Effort: small
- Files: `server.js:980-981` (ATTN-MISS), `server.js:495-502` (`audit`)
- Depends on: none
- Implementation: replace the `lastLine.substring(0,60)` and 3x80 preview
  with a sha256 prefix + length, matching how the INPUT path already does it
  at `:1671-1672`. Add size-based rotation to `audit()` (rotate at 5 MB, keep
  2 files). Note the current log holds ~2 MB of raw session content across
  7,225 entries -- decide whether to archive or delete it; do not commit it.
- Verification: run a session that triggers ATTN-MISS; confirm no terminal
  text appears in the log. Confirm rotation fires with a forced large write.
- Findings: R-LOG | Behavior: [none]
- Note: this reduces attention-detection debuggability. Acceptable -- W5
  deletes the heuristic entirely.

### T07: Supply-chain gate -- npm ci + audit in CI
- Domain: infra | Action: modify | Risk: low | Effort: small
- Files: `.github/workflows/ci.yml`, `install.sh:285`, `update.sh:70`
- Depends on: T03 (simplifies the syntax-check step)
- Implementation: switch `npm install --production` to `npm ci` in both
  scripts so the lockfile is authoritative rather than advisory. Add
  `npm ci && npm audit --audit-level=high` to CI. Replace the inline-script
  regex syntax check with `node --check public/app.js`.
- Verification: CI fails on an injected high-severity advisory; passes clean
  on HEAD. `npm ci` reproduces the tree from the lockfile.
- Findings: supply chain (assessed as the single most likely compromise path)
- Behavior: [none]

### T08: Boot resilience -- WSL systemd unit (D3)
- Domain: infra | Action: create | Risk: medium | Effort: medium
- Files: `/etc/wsl.conf` (systemd=true), new systemd unit, `install.sh`
- Depends on: none
- Implementation: enable systemd in the Ubuntu-24.04 distro; run the session
  backbone under it so sessions survive independently of the Windows-side
  Node process. In W0 that backbone is still dtach (units keep the distro
  alive); in W5 it becomes the herdr daemon. Design the unit so W5 swaps the
  ExecStart, not the whole approach.
- Verification: `wsl --shutdown`, then confirm the distro and unit come back
  automatically and a pre-existing session is still reachable.
- Decisions: D3 | Behavior: [survives WSL restart]

### T09: Boot resilience -- Windows logon task (D3)
- Domain: infra | Action: create | Risk: medium | Effort: medium
- Files: new `scripts/register-startup.ps1`, `install.sh`
- Depends on: T08
- Implementation: a Scheduled Task at user logon that (1) starts the WSL
  distro, (2) re-asserts `tailscale serve --bg http://localhost:3456`,
  (3) starts the Node server under PM2, and (4) runs `pm2 save` /
  `pm2 resurrect` so the process list persists. This is the specific gap
  that caused the current outage.
- Verification: **reboot the laptop.** Without touching anything, confirm the
  phone can reach the app and an existing session is live. This is the
  acceptance test for the whole wave.
- Decisions: D3 | Behavior: [survives host reboot]

### T10: Watchdog self-check
- Domain: infra | Action: create | Risk: low | Effort: small
- Files: `server.js` (housekeeping timer at `:1753-1787`)
- Depends on: T08
- Implementation: extend the existing 60s housekeeping timer with a backbone
  liveness probe (W0: dtach socket reachable; W5: herdr socket answers
  `ping`). On failure, log a distinct `BACKBONE-DOWN` audit line and surface
  a banner to connected clients. No auto-restart in this wave -- detect and
  report first.
- Verification: kill the backbone by hand; confirm the audit line and the
  client banner appear within 60s.
- Behavior: [failure is visible, not silent]

### T11: Live revival verification
- Domain: verification | Action: verify | Risk: low | Effort: small
- Depends on: T01-T10
- Implementation: bring the service up, create a session from the iPhone AND
  the iPad, run a real Claude task end to end, reboot the laptop, and confirm
  recovery without manual intervention.
- Verification: per the house definition of done -- the original failing
  artifact (a reboot killing everything) re-exercised live and observed
  passing. Green CI does not count.
- Behavior: [service is actually usable again]

---

## Wave 1 -- herdr spike (no release)

Gates D1 option B. One day, timeboxed. Output is a go/no-go plus the
confirmed integration shape, which becomes the input to the W5 tech design.

### S1: herdr feasibility probe
- Domain: spike | Action: investigate | Risk: low | Effort: medium
- Files: new `.planning/spike-herdr-probe.js`, `.planning/spike-report-herdr.md`
- Depends on: none
- Implementation: install herdr in WSL **pinned at v0.8.0** (pre-1.0 protocol
  bumps can strand clients); set `pane_history = true` (off by default for
  secret-safety, so scrollback replay needs it on). Then answer, in order:
  1. **Stream fidelity.** Can `pane.read` (or an event stream) feed our
     headless mirror? Better: is herdr's own pane grid sufficient to drive
     the client directly, retiring `server.js:1057-1198` (206 LOC) AND the
     private-internals reach at `:1099` (`line._line._extendedAttrs[x]._urlId`)?
     This is the highest-value question -- it is the difference between
     retiring ~500 and ~700 LOC.
  2. **Agent state under both launch modes (decides D2).** Does herdr report
     idle/working/blocked/done for Claude launched (a) natively in WSL, and
     (b) via `cmd.exe /c claude` interop? Hypothesis: interop defeats
     foreground-process detection and breaks resume identity.
  3. **Restart restore.** Kill and restart the daemon: does pane shape come
     back, and does `resume_agents_on_restore` genuinely re-attach the Claude
     conversation?
  4. **Input atomicity.** Does `pane.send_text` deliver text+CR as one write?
     Our known race (`CLAUDE.md:93`) requires atomicity.
- Verification: written spike report with a recommendation and evidence per
  question. No code ships from this wave.
- Decisions: D1, D2 | Behavior: [none]

---

## Wave 2 -- iPad client (3.3.0)

Runs in PARALLEL with W1 -- entirely independent of the herdr decision.
This is the wave that makes the thing pleasant to use.

### T12: Global hardware-keyboard handler
- Domain: frontend | Action: create | Risk: high | Effort: large
- Files: `public/app.js` (post-T03), input section formerly at
  `index.html:1747-1862`
- Depends on: T03
- Implementation: a document-level `keydown` handler that forwards keystrokes
  straight to the PTY when a terminal is focused and no form field has focus.
  Today the ONLY keydown listeners are form-scoped (`:47`, `:446`, `:450`,
  `:1987`) -- there is no path from a physical key to the PTY at all. Cover:
  printable chars, Enter, Backspace, Tab (completion), Esc, arrows, Ctrl-C /
  Ctrl-D / Ctrl-Z / Ctrl-R (map to control codes 0x03/0x04/0x1a/0x12),
  Home/End/PgUp/PgDn, and Cmd-K style app shortcuts. Send as a single atomic
  write per key. Preserve the compose box for long multi-line prompts.
- Verification: with a Magic Keyboard attached, drive a full Claude session
  without touching the screen: type a prompt, Esc to interrupt, Ctrl-C, use
  arrow-key history, tab-complete a path.
- Decisions: D5 | Behavior: [iPad becomes a real terminal]
- Risk note: highest-risk task in the plan. Key handling interacts with IME,
  autocorrect, and the existing compose box. Build behind a setting so it can
  be switched off if it misbehaves.

### T13: Responsive breakpoints
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/style.css`
- Depends on: none
- Implementation: `style.css` currently has ZERO width breakpoints -- the
  only media query is `prefers-reduced-motion` at `:552`. Add breakpoints at
  ~820px and ~1180px: at iPad width give the terminal the full viewport,
  promote the tab bar to persistent, and stop constraining widths to phone
  values (`:112` 280px, `:164` 180px, `:464` 100px).
- Verification: visual smoke at phone / tablet / desktop widths per the house
  UI rule. No horizontal body scroll at any width.
- Decisions: D5 | Behavior: [layout fits the device]

### T14: Full-screen terminal + font-size setting
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/app.js`, `public/style.css`, `public/index.html:5` (viewport)
- Depends on: T12, T13
- Implementation: with a hardware keyboard the software keyboard never
  appears, so the terminal takes the full screen -- this is the operator's
  core ask. Add a font-size setting (persisted to localStorage) and recompute
  columns from it via the existing `measureCharWidth` path. Expect ~100 cols
  at a comfortable size on a 1366px iPad vs the iPhone's ~50; readable beats
  dense. Reconsider `maximum-scale=1.0, user-scalable=no` at `index.html:5`
  now that pinch-zoom is not competing with a cramped layout.
- Verification: font change re-fits columns correctly and the PTY resize
  reaches the server (check `grid.cols` matches after the change).
- Decisions: D5 | Behavior: [larger readable font, full screen]

### T15: Demote swipe navigation to narrow widths
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/app.js` (formerly `index.html:1496-1745`, 250 LOC)
- Depends on: T13
- Implementation: swipe-between-sessions exists because a 390px screen shows
  one session at a time; on iPad it competes with iPadOS edge gestures and
  earns much less. Gate the touch handlers behind the narrow breakpoint and
  make the persistent tab bar primary at tablet width. Keep the code -- do
  not delete; phone remains a supported client.
- Verification: at iPad width, horizontal drags do not switch sessions and
  system edge gestures behave normally; at phone width swipe is unchanged.
- Decisions: D5 | Behavior: [no gesture conflict on iPad]

### T16: Server-side resize arbitration
- Domain: api | Action: modify | Risk: medium | Effort: medium
- Files: `server.js:1681-1707` (`resize` case)
- Depends on: none
- Implementation: today resize is last-writer-wins across clients
  (`HANDOVER.md:24`), mitigated only defensively on the client. With iPad and
  iPhone both attached this fires constantly. Track per-client dims on the
  session and set the PTY to the **minimum** across attached viewers (or a
  designated primary). Broadcast the resulting snapshot once.
- Verification: attach two clients at different widths; confirm the PTY
  settles deterministically and neither client renders against stale dims.
- Findings: HANDOVER.md:24 | Behavior: [multi-client resize is stable]

### T17: Version bump 3.2.19 -> 3.3.0
- Domain: config | Action: modify | Risk: low | Effort: small
- Depends on: T12-T16

---

## Wave 3 -- Security tier 2 (3.3.1)

Everything from D6 Tier 2. Each is small and independent.

### T18: Origin check on the WebSocket upgrade (R2)
- Domain: api | Action: modify | Risk: low | Effort: small
- Files: `server.js:1421` (add `verifyClient` to the `WebSocketServer` opts)
- Implementation: WebSockets are exempt from CORS, and `*.ts.net` resolves in
  public DNS with a real cert, so any page open on a tailnet device can
  connect and burn the global limiter into a repeatable 10-minute lockout.
  Reject upgrades whose `Origin` is not the expected tailnet host or
  localhost.
- Verification: a `new WebSocket()` from an unrelated origin is refused; the
  real client still connects.
- Findings: R2 | Behavior: [drive-by DoS closed]

### T19: CSRF guard on /api/totp/reset (R3)
- Domain: api | Action: modify | Risk: low | Effort: small
- Files: `server.js:817-829`
- Implementation: require `Sec-Fetch-Site: same-origin` (or an explicit Origin
  match) plus a JSON content-type so the request is no longer a CORS "simple
  request". Today any site open in the laptop's browser can overwrite
  `.totp-secret`.
- Verification: cross-origin `fetch(..., {mode:'no-cors'})` no longer resets;
  the legitimate setup page still does.
- Findings: R3 | Behavior: [TOTP cannot be remotely clobbered]

### T20: Remove the query-string token source (R6)
- Domain: api | Action: delete | Risk: low | Effort: small
- Files: `server.js:648` (`req.query?.st`)
- Implementation: delete the branch; no client uses it. Add
  `Referrer-Policy: no-referrer` while in the header block.
- Verification: `grep -n 'query?.st' server.js` returns nothing; auth still
  works via header and WS.
- Findings: R6

### T21: Sanitize msg.name at create (R5)
- Domain: api | Action: modify | Risk: low | Effort: small
- Files: `server.js:1618` -> `createSession`
- Implementation: apply the same treatment `rename` already does at `:1713`
  (`.slice(0,50).replace(/[<>"'&]/g,'')`). Unbounded names with embedded
  newlines currently forge audit-log lines.
- Verification: a name containing `\n` and `<script>` is stored sanitized and
  produces exactly one audit line.
- Findings: R5

### T22: getClientIP -- rightmost XFF hop (A2)
- Domain: api | Action: modify | Risk: low | Effort: small
- Files: `server.js:1410-1419`
- Implementation: `xff.split(',')[0]` takes the LEFTMOST hop, the most
  attacker-controllable position, and the opposite of what `proxy-addr` does
  two functions away. Take the rightmost untrusted hop, or simply reuse
  `proxy-addr` for both paths. Currently rescued only by Tailscale stripping
  inbound XFF -- do not depend on an external component the code never checks.
- Verification: `curl -H "X-Forwarded-For: 1.2.3.4" https://<tailnet-host>/api/auth/status`
  then `grep 1.2.3.4 ~/.claude-mobile-audit.log` -- no hit.
- Findings: A2

### T23: wslExec -> execFileSync argv (N1)
- Domain: api | Action: modify | Risk: medium | Effort: medium
- Files: `server.js:81-85` and its 4 call sites (`:103`, `:123`, `:142`, `:151-153`)
- Implementation: `execSync` interpolates into `bash -c "..."` escaping only
  double quotes, routed through cmd.exe which does not honour `\"`. No
  client-reachable path today (dirs allowlisted by exact match, session ids
  are numeric Map keys) -- but it becomes root RCE in WSL the day a project
  dir contains a backtick, `$`, or `&`. Convert to
  `execFileSync('wsl.exe', [...args])`, which removes the entire class.
- Verification: sessions create, list, probe, and kill normally; add a config
  fixture with a `$` in the path and confirm it is handled literally.
- Findings: N1 | Behavior: [injection class eliminated]
- Note: W5 deletes most of these call sites. Do this only if W5 slips; if W5
  is imminent, fold it in there instead.

---

## Wave 4 -- The E2E decision (3.3.2)

D6 Tier 3. **Operator decision required before this wave starts:** fix or
delete. Do not leave as-is -- as-is is what makes these two layers a net
negative.

### T24 (option FIX): Direction-separated nonces + client downgrade guards
- Domain: api + frontend | Action: modify | Risk: medium | Effort: small
- Files: `server.js:336-337`, `public/app.js` (formerly `index.html:280-282`,
  `:302-303`, `:270-277`)
- Implementation: three changes, roughly ten lines total.
  1. **C1:** add a direction byte to the IV -- `iv[0] = isServer ? 1 : 0` --
     or use two HKDF labels. Both sides currently derive the same key and
     start the counter at 1 with no direction separation, so server message
     #1 (a fixed known plaintext) and client message #1 (the TOTP) share a
     nonce. XOR recovers the code in cleartext.
  2. **C2:** move the `type:'encrypted'` and `type:'key-exchange'`
     short-circuits BELOW the anti-downgrade guard, and make the client
     refuse any plaintext send once a handshake has begun.
  3. **C3:** client must refuse post-handshake rekey, matching the server,
     which already does this correctly.
- Verification: capture both directions' first frames and confirm the IVs
  differ; confirm an injected plaintext `{"type":"encrypted"}` no longer
  triggers a cleartext credential send; confirm an injected mid-session
  `key-exchange` is rejected without a `confirm()` prompt.
- Findings: C1, C2, C3

### T25 (option DELETE): Remove the E2E layer
- Domain: api + frontend | Action: delete | Risk: medium | Effort: medium
- Implementation: strip ~342 LOC across `server.js:245-392` and the client
  mirror; TLS + WireGuard remain. Loses only the rogue-Tailscale-control-plane
  defence; recovers a whole class of decrypt-failure reconnect bugs.
- Recommendation: **FIX rather than delete** -- it is ten lines and keeps the
  pinning story honest -- but do not rebuild it from scratch if it ever comes
  out.

---

## Wave 5 -- herdr backbone (4.0.0)

GATED on S1. **Requires a tech design first** (`dt.engineering` ->
`tech-design-herdr-backbone.md`) because the integration shape depends on
spike answers, especially question 1 (whose grid drives the client).

Task list below is indicative, to be firmed up by the tech design.

### T26: Tech design -- herdr integration
- Domain: design | Action: create | Risk: low | Effort: medium
- Files: `.planning/tech-design-herdr-backbone.md`
- Depends on: S1
- Implementation: pin the socket client contract, the grid ownership decision,
  the launch mode (D2), the reconnect/restore semantics, and the failure model
  when the daemon is down.

### T27: herdr socket client
- Domain: api | Action: create | Risk: high | Effort: large
- Files: new `lib/herdr.js` (~150 LOC)
- Implementation: newline-delimited JSON-RPC over the named pipe (Windows) /
  unix socket. Cover `session.snapshot`, `pane.list/read/send_text/resize`,
  `events.subscribe`, `ping`. Reconnect with backoff. Pin the protocol
  version and fail loudly on a mismatch (pre-1.0 bumps strand clients).

### T28: Replace the dtach layer
- Domain: api | Action: delete | Risk: high | Effort: large
- Files: `server.js:42-157` (308 LOC), `:1316-1404` (create/recover)
- Implementation: delete `wslExec`, `listDtachSessions`, `createDtachDaemon`,
  `attachToDtach`, `dtachSessionAlive`, `killDtachSession`, the
  `.session-meta.json` persistence, and `recoverDtachSessions`. Session
  lifecycle becomes herdr pane operations.

### T29: Replace attention detection with herdr agent state
- Domain: api + frontend | Action: delete + modify | Risk: medium | Effort: medium
- Files: `server.js:912-983` (~107 LOC incl. `stripAnsi`), client notification
  block
- Implementation: delete the 12 regexes and the 5s debounce; subscribe to
  `events.subscribe` and push on `blocked` / `done`. Keep the client delivery
  (Web Notification, vibration, red dot) -- only the trigger changes.
- Behavior: [notifications stop guessing]

### T30: Rewire the WS message switch
- Domain: api | Action: modify | Risk: high | Effort: large
- Files: `server.js:1610-1736`
- Implementation: `input` -> `pane.send_text`, `resize` -> `pane.resize`,
  `connect` -> attach + snapshot, `create`/`close` -> pane/tab lifecycle. The
  auth-gated encrypted envelope around it is unchanged.

### T31: Retire the server-side grid mirror (CONDITIONAL on S1 Q1)
- Domain: api | Action: delete | Risk: medium | Effort: medium
- Files: `server.js:1016-1055`, `:1057-1198` (206 LOC)
- Implementation: only if herdr's pane grid proved sufficient. Also removes
  the private-internals dependency at `:1099`.

### T32: Multi-pane iPad layout
- Domain: frontend | Action: create | Risk: medium | Effort: large
- Depends on: T27, W2
- Implementation: herdr's workspace -> tab -> pane hierarchy is wasted on a
  phone but maps directly onto an iPad. Render two or more panes side by side
  at tablet width, each with its own live agent-state badge.
- Behavior: [watch multiple sessions at once]

### T33: Swap the systemd unit to herdr
- Domain: infra | Action: modify | Risk: low | Effort: small
- Depends on: T08, T28
- Implementation: the W0 unit was designed for this swap -- change ExecStart,
  keep the approach. Update T10's watchdog probe to `ping` the herdr socket.

### T34: Version bump 3.3.2 -> 4.0.0
- Domain: config | Action: modify | Risk: low | Effort: small

---

## Wave 6 -- Cleanup + artifacts (4.0.1)

### T35: Lazy-load the xterm.js vendor bundle
- Domain: frontend | Action: modify | Risk: low | Effort: small
- Files: `public/index.html:10, 109-112`
- Implementation: 478 KB of xterm.js is loaded unconditionally on every page
  load and never touched by the default grid renderer. Load the four bundles
  dynamically ONLY when `?renderer=xterm` is present. This is the T27 payload
  win without deleting the fallback the operator chose to keep.
- Verification: Network tab shows zero vendor requests in default mode; the
  `?renderer=xterm` path still works.

### T36: Dead code + doc sweep
- Domain: cleanup | Action: delete | Risk: low | Effort: small
- Implementation: delete `SESSION.md` (dated 2026-04-12, contradicts
  HANDOVER.md); `wslPathToWin` (`server.js:93`); `dumpHeadlessGrid` (`:1180`);
  the `client-log` no-op (`:1709`) and its 15 client emit sites; grid-mode-dead
  scroll zones (`index.html:1864-1946`); the merged `render-pipeline/*`
  branches; `.planning/spike-w6-*` artifacts. Resolve the `CLAUDE.md:71`
  contradiction (it forbids JS touching `appEl.style.height`; the
  visualViewport handler does exactly that) -- decide which is right and fix
  the other.

### T37: Shared connect-message builder
- Domain: frontend | Action: modify | Risk: low | Effort: small
- Implementation: the W6 post-mortem lesson
  (`memory/project_w6_history_render_bug.md:84-88`) was never implemented.
  Three call sites each hand-roll the `renderer` field and one hardcodes
  `'grid'`. A single builder removes the exact defect class that forced the
  first cutover revert.

### T38: Artifact tray (nice-to-have)
- Domain: frontend + api | Action: create | Risk: medium | Effort: large
- Depends on: T04 (CSP shapes this), W2
- Implementation: surface files Claude writes in the session's project dir
  (or subscribe to a herdr plugin `[[events]]` hook) as a per-session tray.
  Render images natively, diffs in a simple viewer, PDFs via the native iPad
  viewer, and HTML in a **sandboxed iframe or separate origin** -- the T04
  CSP tightening forbids inline injection. Prior art exists on the herdr
  socket (`powerfooI/herdr-gui` ships diff viewers).
- Behavior: [decision sheets and diffs viewable from the iPad]

---

## Sequencing summary

```
NOW      W0-T01 (XSS)  -- own PR, own release, ships alone
Week 1   W0 rest       -- CSP, perms, logging, supply chain, boot resilience
                          acceptance test = reboot the laptop and it comes back
Week 1-2 W1 (spike)  ||  W2 (iPad client)   <- run in parallel
Week 2   W3           -- security tier 2
Week 2   W4           -- E2E fix or delete (operator decision needed)
Week 3-4 W5           -- tech design, then herdr backbone
Week 4   W6           -- cleanup + artifacts
```

## Open operator decisions

1. **W4:** fix the E2E layer (~10 LOC, recommended) or delete it (~342 LOC out)?
2. **W5 D2:** native-WSL Claude vs `cmd.exe` interop -- S1 Q2 will likely
   decide this on evidence, but the /mnt/c performance trade is a judgement call.
3. **T06:** archive or delete the ~2 MB of terminal content in the existing
   audit log?
4. **T23:** fold into W5 (if herdr is imminent) or ship standalone in W3?
