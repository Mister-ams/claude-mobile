---
project: claude-mobile
type: plan
status: active
created: 2026-03-23
updated: 2026-05-01
source: .planning/tech-design-render-pipeline.md
inherited_from: none
---

# Plan: Render Pipeline

33 tasks across 7 waves on the 3.2.x patch line. Single-developer linear
execution. W1-W3 ship on current xterm.js (low risk, reversible). W4 is a
discovery spike. W5 introduces the new pipeline behind a per-session flag.
W6 cuts over and removes xterm.js. W7 is polish.

Decisions cited as `D1..D10` and EARS as `E1..E8` from
`tech-design-render-pipeline.md`.

---

## Wave 1 -- Coalesce (3.2.2)

Server-side `proc.onData` buffer + client rAF batching of `term.write`.
No architectural change. Reversible by reverting commits.

### T01: Bump package.json version 3.1.5 -> 3.2.2
- Domain: config | Action: modify | Risk: low | Effort: small
- Files: `package.json`
- Depends on: none
- Verification: `grep '"version": "3.2.2"' package.json` exits 0
- Decisions: D10 | Behavior: [none]

### T02: Server-side onData coalescer
- Domain: api | Action: modify | Risk: medium | Effort: medium
- Files: `server.js` (lines 1013-1047, `wireSessionProc`)
- Depends on: none
- Implementation: buffer chunks; flush on 16 ms idle timer OR 4 KB byte cap
  OR 64 ms hard max-age, whichever fires first; emit one `output` message
  per flush. Preserve existing scrollback append + attention debounce.
- Verification: under 1k-token Claude stream, server logs show >=4x fewer
  `secureSend(output)` calls vs HEAD~1
- Decisions: D1 | Behavior: [none]

### T03: Client rAF batching of term.write
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html` (lines 771-788, output case)
- Depends on: T02
- Implementation: queue `m.data` per session into `pendingWrites[id]`; on
  first message, schedule a single `requestAnimationFrame` that flushes via
  one `term.write(combined)` and runs the existing scroll-preserve logic
  once per frame, not per message.
- Verification: DevTools profile shows one term.write per rAF tick during
  active stream
- Decisions: D2 | Behavior: [none]

### T04: W1 smoke verification
- Domain: test | Action: create | Risk: low | Effort: small
- Files: none (manual smoke)
- Depends on: T03
- Verification: (a) WS frame count drops >=4x under sustained Claude
  output; (b) iOS streaming visibly smoother; (c) vim and htop still
  render correctly through the unchanged xterm.js client
- Decisions: D1, D2 | Behavior: [none]

---

## Wave 2 -- Fidelity audit + resize wire (3.2.3)

Confirm the v3 WS path filters no sequences. Wire client resize ->
server `proc.resize` immediately.

### T05: Audit WS path for sequence filtering
- Domain: test | Action: create | Risk: low | Effort: small
- Files: `.planning/audit-fidelity-pre-w5.md` (new)
- Depends on: none
- Implementation: read every `secureSend` and message handler in
  `server.js` and `public/index.html`; document any filtering, stripping,
  or rewriting of bytes between PTY and `term.write`. Expected: none.
- Verification: audit doc lists every site touched and states findings
- Decisions: [none] | Behavior: E5, E6, E7

### T06: Wire resize through to dtach PTY
- Domain: api + frontend | Action: modify | Risk: medium | Effort: medium
- Files: `server.js`, `public/index.html`
- Depends on: T05
- Implementation: client emits `{type:'resize', cols, rows}` debounced
  100 ms after pointer-up on resize handles or window-resize end; server
  calls `session.proc.resize(cols, rows)` immediately on receipt; bounds
  check cols [10,400] rows [5,200].
- Verification: rotate phone -> within 100 ms the CLI reflows; no doubled
  prompt rows or clipped messages
- Decisions: D9 | Behavior: E4

### T07: W2 smoke verification
- Domain: test | Action: create | Risk: low | Effort: small
- Files: none (manual smoke)
- Depends on: T06
- Verification: alt-screen (vim, htop) renders correctly; mouse selection
  in vim works; OSC 8 clickable file paths in markdown output; cursor
  positioning correct after resize
- Decisions: [none] | Behavior: E4, E5, E6, E7

---

## Wave 3 -- Render loop (3.2.4)

Client `requestLive` / `dropLive` ref-counted single rAF loop replacing
scattered timers and per-call rAF.

### T08: Introduce live-counter rAF loop
- Domain: frontend | Action: create | Risk: medium | Effort: medium
- Files: `public/index.html`
- Depends on: T03
- Implementation: module-scoped `liveCount`, `requestLive()`, `dropLive()`,
  one rAF loop that runs while `liveCount > 0` and stops when it hits 0;
  re-armed on next `requestLive`.
- Verification: DevTools shows zero rAF callbacks while idle; one per
  frame while streaming
- Decisions: [none] | Behavior: [none]

### T09: Migrate scroll/attention/animation to live-counter
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html`
- Depends on: T08
- Implementation: replace ad-hoc rAF in `scrollBottom` and the attention
  debounce visibility logic with `requestLive`/`dropLive` pairs; ensure
  WS message arrival calls `requestLive` and the rAF tick calls
  `dropLive` after the queue drains.
- Verification: pause WS traffic -> rAF stops within one frame
- Decisions: [none] | Behavior: [none]

### T10: W3 smoke verification
- Domain: test | Action: create | Risk: low | Effort: small
- Files: none (manual smoke)
- Depends on: T09
- Verification: idle CPU on phone <=1% over 60 s observed in mobile
  browser performance tab
- Decisions: [none] | Behavior: [none]

---

## Wave 4 -- Headless xterm spike (3.2.5)

Add `@xterm/headless` server-side off the live dtach PTY. Validate full
fidelity. Not user-visible. Go/no-go gate for W5.

### T11: Add @xterm/headless dependency
- Domain: config | Action: modify | Risk: low | Effort: small
- Files: `package.json`, `package-lock.json`
- Depends on: none
- Implementation: `npm install @xterm/headless` (pin to current major).
- Verification: `node -e "require('@xterm/headless')"` exits 0
- Decisions: D3 | Behavior: [none]

### T12: HeadlessSession prototype attached to dtach
- Domain: api | Action: create | Risk: medium | Effort: medium
- Files: `server.js`
- Depends on: T11
- Implementation: per session, instantiate `Terminal` from
  `@xterm/headless` at current cols/rows; pipe `proc.onData` into both
  the existing client broadcast path AND the headless terminal via
  `term.write`. Do not wire to client. Add a debug `dumpHeadlessGrid(id)`
  helper that returns the current cell grid for inspection.
- Verification: `dumpHeadlessGrid` after a Claude turn shows the same
  visible text as the xterm.js client
- Decisions: D3 | Behavior: E1

### T13: Fidelity validation
- Domain: test | Action: create | Risk: medium | Effort: medium
- Files: `.planning/spike-report-headless-xterm.md` (new -- WIP)
- Depends on: T12
- Implementation: drive live Claude Code REPL + `vim` + `htop` + a
  command emitting OSC 8 hyperlinks; capture xterm.js client render;
  capture `dumpHeadlessGrid`; compare. Probe `@xterm/headless` API for
  OSC 8 link metadata access.
- Verification: byte-for-byte match across REPL / alt-screen TUI / OSC 8;
  any monkey-patching needed is documented
- Decisions: D3 | Behavior: E5, E6

### T14: Spike report
- Domain: docs | Action: create | Risk: low | Effort: small
- Files: `.planning/spike-report-headless-xterm.md`
- Depends on: T13
- Implementation: write findings, OSC 8 access pattern, any workarounds,
  go/no-go recommendation for W5.
- Verification: report committed; W5 unblocked
- Decisions: D3 | Behavior: [none]

---

## Wave 5 -- Diff transport behind flag (3.2.6)

Snapshot + Frame wire, server diff builder, client cell-grid renderer.
Per-session opt-in flag. Both pipelines coexist.

### T15: Cell-grid model + diff builder
- Domain: api | Action: create | Risk: high | Effort: large
- Files: `server.js`
- Depends on: T13
- Implementation: per session, after each headless `term.write`, walk
  the active buffer; produce `RowChange[]` against `lastEmittedGrid` with
  RLE-collapsed `CellRun[]`; export functions `buildSnapshot(session)`
  and `buildFrame(session)` returning the TypeSpec shapes from the TDD.
- Verification: unit smoke: write a known sequence, assert frame contains
  expected rows + runs
- Decisions: D4 | Behavior: E1, E3

### T16: Cell-grid scrollback (replace byte ring buffer)
- Domain: api | Action: modify | Risk: high | Effort: medium
- Files: `server.js` (replaces lines 1015-1022 buffer)
- Depends on: T15
- Implementation: keep a rolling `scrollbackRows: RowChange[]` capped at
  5000 rows per session, fed by lines that scroll off the headless
  viewport; remove `session.scrollback` string accumulator (kept until
  W6 cutover for parallel-pipeline safety -- gate by feature flag
  presence).
- Verification: 5000-row generation script truncates correctly; reconnect
  snapshot returns most-recent 5000 rows
- Decisions: D8 | Behavior: E2

### T17: WS Snapshot + Frame senders (flagged)
- Domain: api | Action: create | Risk: medium | Effort: medium
- Files: `server.js`
- Depends on: T15, T16
- Implementation: on connect, if session flag `renderer=grid`, send
  `Snapshot` (full viewport + scrollback) before any `Frame`; thereafter
  emit `Frame` only when `buildFrame` returns non-empty changes; monotonic
  `seq` per session.
- Verification: reconnect on flagged session sends exactly one Snapshot
  before any Frame; idle sessions emit zero Frames
- Decisions: D5, D6 | Behavior: E1, E2, E3

### T18: WS Resize handler -> headless resize
- Domain: api | Action: modify | Risk: medium | Effort: small
- Files: `server.js`
- Depends on: T17
- Implementation: on `Resize`, call `session.proc.resize(cols, rows)` AND
  `session.headless.resize(cols, rows)`; next `buildFrame` reflects new
  size. Bounds check cols [10,400] rows [5,200].
- Verification: client resize -> server logs both resizes within one
  tick; next Frame matches new dimensions
- Decisions: D9 | Behavior: E4

### T19: Client cell-grid renderer (flagged)
- Domain: frontend | Action: create | Risk: high | Effort: large
- Files: `public/index.html`
- Depends on: T17
- Implementation: cell-grid DOM (one row = one element with styled spans
  per `CellRun`); per-session flag from URL param `?renderer=grid` OR
  settings toggle; coexist with xterm.js mount (only one active per
  session).
- Verification: flagged session renders a static dump correctly; non-
  flagged session unchanged
- Decisions: D6 | Behavior: [none]

### T20: Client Snapshot + Frame application
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html`
- Depends on: T19
- Implementation: handle `snapshot` (replace grid + scrollback + cursor),
  `frame` (apply `RowChange[]` to grid + scrollback rotation + cursor),
  altScreen toggle. On `visibilitychange` -> `visible`, request fresh
  snapshot and discard buffered frames.
- Verification: live Claude session renders identically to xterm.js
  client
- Decisions: D4, D6 | Behavior: E2, E5, E8

### T21: OSC 8 -> clickable anchors
- Domain: frontend | Action: modify | Risk: low | Effort: small
- Files: `public/index.html`
- Depends on: T20
- Implementation: in cell renderer, if `sgr.hyperlink` set, wrap the run
  in an `<a target="_blank" rel="noopener">`.
- Verification: a markdown response with file paths shows clickable links
- Decisions: [none] | Behavior: E6

### T22: Mouse-tracking event forwarding
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html`
- Depends on: T20
- Implementation: when `Snapshot.mouseTracking` true, intercept pointer
  down/move/up over the grid, encode as the active mouse-tracking
  protocol (1006 SGR), and send via `Input`.
- Verification: in `vim` `:set mouse=a`, click positions cursor; scroll
  wheel sends scroll events
- Decisions: [none] | Behavior: E7

### T23: W5 smoke verification
- Domain: test | Action: create | Risk: medium | Effort: small
- Files: none (manual smoke)
- Depends on: T20, T21, T22
- Verification: flagged session renders Claude Code REPL, Bash output,
  vim, htop indistinguishably from xterm.js client; OSC 8 clickable;
  resize <=100 ms; tab background+return triggers fresh snapshot
- Decisions: D6 | Behavior: E2, E4, E5, E6, E7, E8

---

## Wave 6 -- Cutover (3.2.7)

Default flip after >=24 h clean soak. Remove the legacy raw-byte path and
the xterm.js client bundle.

### T24: Flip default renderer to grid
- Domain: config | Action: modify | Risk: medium | Effort: small
- Files: `server.js`, `public/index.html`
- Depends on: T23
- Implementation: invert the per-session flag default; URL param
  `?renderer=xterm` becomes the legacy opt-in for soak.
- Verification: new session without param uses grid renderer
- Decisions: D7 | Behavior: [none]

### T25: 24h soak verification
- Domain: test | Action: create | Risk: low | Effort: small
- Files: none (manual smoke)
- Depends on: T24
- Verification: >=24 h continuous use covering Claude REPL + Bash + vim +
  htop + OSC 8 with no fidelity regressions
- Decisions: D7 | Behavior: [none]

### T26: Remove legacy WS handlers
- Domain: api + frontend | Action: delete | Risk: medium | Effort: medium
- Files: `server.js`, `public/index.html`
- Depends on: T25
- Implementation: remove `output` message senders + handlers, raw
  `scrollback`/`scrollback-chunk`/`scrollback-end` paths, the
  `session.scrollback` string accumulator, and the legacy `?renderer=xterm`
  branch.
- Verification: grep for `'output'` and `'scrollback'` shows no remaining
  client-bound payloads on the legacy shape
- Decisions: D7 | Behavior: [none]

### T27: Delete xterm.js vendor files
- Domain: config | Action: delete | Risk: low | Effort: small
- Files: `public/vendor/xterm.min.js`, `xterm.min.css`,
  `addon-fit.min.js`, `addon-webgl.min.js`, `addon-canvas.min.js`
- Depends on: T26
- Implementation: `git rm` each; remove `<script>` and `<link>` tags from
  `public/index.html`.
- Verification: page loads with no 404; `Network` tab shows no xterm
  asset
- Decisions: D7 | Behavior: [none]

### T28: Update CLAUDE.md
- Domain: docs | Action: modify | Risk: low | Effort: small
- Files: `CLAUDE.md`
- Depends on: T27
- Implementation: remove xterm.js gotchas; document the headless-xterm +
  cell-grid architecture; cite TDD path.
- Verification: peer read confirms architecture matches code
- Decisions: [none] | Behavior: [none]

### T29: W6 smoke verification
- Domain: test | Action: create | Risk: low | Effort: small
- Files: none (manual smoke)
- Depends on: T28
- Verification: client bundle size dropped by >=400 KB; load time
  improved on cold mobile load; no regressions vs T23 baseline
- Decisions: [none] | Behavior: [none]

---

## Wave 7 -- Polish (3.2.8)

Rope-tail / commit-on-settle, viewport culling, single bracketed-paste
and IME parser layer.

### T30: Rope-tail / commit-on-settle in renderer
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html`
- Depends on: T29
- Implementation: split the rendered DOM into a "live tail" node (last N
  rows, freely re-rendered per frame) and a "frozen" parent that only
  appends finalised rows. Settled rows defined by N-row gap above the
  cursor.
- Verification: streaming markdown shows fewer DOM mutations per frame
  in DevTools `Performance`
- Decisions: [none] | Behavior: [none]

### T31: Viewport culling
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html`
- Depends on: T30
- Implementation: only mount visible rows + small overscan (10 rows
  above + below); rows scrolled out unmounted.
- Verification: 5000-row scrollback session has <=200 row elements
  mounted at any time
- Decisions: [none] | Behavior: [none]

### T32: Single bracketed-paste / IME parser layer
- Domain: frontend | Action: modify | Risk: medium | Effort: medium
- Files: `public/index.html`
- Depends on: T31
- Implementation: consolidate scattered touch and key handlers
  (paste, IME composition, scroll zones) into one input parser that
  produces canonical `Input` payloads. Removes the
  `confirm()`-blocks-WS workaround entry by removing `confirm()`
  callsites entirely.
- Verification: paste preserves bracketed-paste markers when CLI requests
  them; IME composition produces final text only on commit; iOS
  passkey prompt UX unchanged
- Decisions: [none] | Behavior: [none]

### T33: W7 smoke verification
- Domain: test | Action: create | Risk: low | Effort: small
- Files: none (manual smoke)
- Depends on: T32
- Verification: streaming markdown reduces DOM mutation; mounted-row
  count bounded; full input matrix (paste, IME, mouse, keyboard, soft
  keyboard) works
- Decisions: [none] | Behavior: [none]

---

## Verification Mapping

| #   | Criterion                                                  | EARS | Tasks         | Type   |
|-----|------------------------------------------------------------|------|---------------|--------|
| V1  | WS frame count drops >=4x under sustained Claude stream    | -    | T04           | manual |
| V2  | iOS streaming visibly smoother                             | -    | T04           | manual |
| V3  | TUI cursor (vim, htop) unchanged through unchanged xterm   | E5   | T04           | manual |
| V4  | WS path filters no sequences (audit)                       | E5,E6,E7 | T05      | manual |
| V5  | Resize within 100 ms of pointer-up                         | E4   | T07, T23     | manual |
| V6  | Idle CPU on phone <=1%                                     | -    | T10          | manual |
| V7  | Headless xterm reproduces visible output byte-for-byte     | E1   | T13          | manual |
| V8  | OSC 8 access pattern documented                            | E6   | T13, T14     | manual |
| V9  | Reconnect emits exactly one Snapshot before any Frame      | E2   | T17          | manual |
| V10 | Idle sessions emit zero Frames                             | E3   | T17          | manual |
| V11 | Flagged session renders REPL/Bash/vim/htop indistinguishably | E5 | T23          | manual |
| V12 | OSC 8 clickable in flagged session                         | E6   | T21, T23     | manual |
| V13 | Mouse tracking forwarded                                   | E7   | T22, T23     | manual |
| V14 | Tab background+return -> fresh Snapshot                    | E8   | T20, T23     | manual |
| V15 | 24 h soak clean                                            | -    | T25          | manual |
| V16 | Bundle size dropped by >=400 KB                            | -    | T29          | manual |
| V17 | Streaming markdown reduces DOM mutation                    | -    | T33          | manual |
| V18 | Mounted-row count bounded                                  | -    | T33          | manual |

All 8 EARS statements (E1..E8) covered. All 7 wave verification bullets
from the TDD covered.

---

## Wave Summary

| Wave | Release | Tasks | Deliverable                                          | Risk profile |
|------|---------|-------|------------------------------------------------------|--------------|
| W1   | 3.2.2   | 4     | Coalesced streaming, smoother iOS                    | low          |
| W2   | 3.2.3   | 3     | Fidelity audit + responsive resize                   | low          |
| W3   | 3.2.4   | 3     | Idle render loop                                     | low-med      |
| W4   | 3.2.5   | 4     | Headless xterm spike + report                        | medium       |
| W5   | 3.2.6   | 9     | Cell-grid + diff transport behind flag               | high         |
| W6   | 3.2.7   | 6     | Cutover, xterm.js removed                            | medium       |
| W7   | 3.2.8   | 4     | Rope-tail, viewport culling, single input parser     | low-med      |
