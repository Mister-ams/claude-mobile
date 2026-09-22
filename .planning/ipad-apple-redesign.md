# iPad-first Apple redesign, GPU rendering, WebKit simulator

## Why
The iPad client is not at "fine-tuning" quality: duplicated auth text, serif controls in Safari, a dark-only palette, and a default grid renderer that is plain DOM with no GPU path. Every iPad test ran in Chromium, never WebKit.
Goal: reach a state where the operator gives polish feedback, not structural feedback -- measured in a WebKit iPad simulator before any live use.
Appetite: L. No-gos: dark mode or a theme toggle, native app, phone-layout polish, server/session-backend changes, scrollback above the viewport, touching live 3456 before merge.

## Decisions
- D1 2026-09-22 Light theme only, one token set; the dark theme and its toggle are deleted, not hidden (operator rule: never dark mode).
- D2 2026-09-22 Apple look via the system font stack (-apple-system / SF on iPad); no webfont, since SF is not licensed for web embedding and CSP font-src is 'self'.
- D3 2026-09-22 Icons are self-drawn inline SVG in the SF Symbols style; SF Symbols themselves may not ship in a web page.
- D4 2026-09-22 The simulator is Playwright WebKit with the iPad Pro 11 / iPad (gen 11) profiles. On Windows it reports maxTouchPoints=0, so taps arrive as mouse events; on-screen keyboard and pinch stay real-iPad checks.
- D5 2026-09-22 Two harness tiers: a static tier (no server, synthetic session) gates every task; a live tier runs against a throwaway instance on 3457 with its own TOTP and herdr prefix, never against 3456 or cm-0.
- D6 2026-09-22 GPU work starts with a measured probe (T09); the renderer decision follows the numbers, not the other way round.
- D7 2026-09-22 Any CSP change lands in server.js and test/static-server.js together, or the harness stops modelling production.

## Tasks
- [ ] T01 WebKit iPad static harness with a screenshot baseline
  files: test/ipad-webkit.py, test/static-server.js
  check: runs in WebKit at iPad Pro 11 portrait+landscape and iPad (gen 11); writes PNGs + metrics; exits non-zero on any console error or CSP violation; has been watched failing once
  risk: low
- [ ] T02 Live WebKit harness against a throwaway 3457 instance
  files: test/ipad-webkit-live.py, scripts/throwaway-instance.ps1
  check: creates its own worktree install (no node_modules junction), own TOTP and herdr prefix; runs sign-in, existing screen shown, tap moves pane focus, split drag resizes, typed echo, rotate, lock/reconnect; teardown runs herdr session stop+delete; 3456 /health and cm-0 unchanged before vs after
  after: T01
  risk: high
- [ ] T03 Login screen defects
  files: public/index.html, public/app.js, public/style.css
  check: one instruction line on the TOTP screen; buttons and inputs render sans-serif in WebKit (form-control font inherit); T01 screenshot diff reviewed
  after: T01
  risk: low
- [ ] T04 Apple light token set as the single colour source
  files: public/style.css, public/setup.html, public/app.js, public/index.html
  check: dark :root and the .light overrides are gone; 0 hardcoded colours outside the token block in style.css and setup.html; theme-color meta present at load; status bar style is default
  after: T03
  risk: med
- [ ] T05 Light terminal palette shared by grid and xterm
  files: public/app.js, public/style.css
  check: one ANSI 16-colour palette feeds both renderers; every ANSI colour meets WCAG AA 4.5:1 against the terminal background (asserted in the harness); reverse video readable
  after: T04
  risk: med
- [ ] T06 iPad shell: sidebar, toolbar, materials
  files: public/index.html, public/style.css, public/app.js
  check: sessions sidebar in landscape and collapsible in portrait; translucent toolbar/header; every tap target >= 44pt; the terminal area is not smaller than today at iPad Pro 11 (harness metric)
  after: T04
  risk: med
- [ ] T07 Controls in iOS style: chips, input bar, settings sheet, auth
  files: public/index.html, public/style.css, public/app.js, public/setup.html
  check: settings as a grouped list with iOS switches; input bar and send button restyled; auth screen follows the same system; all harness flows still pass
  after: T06
  risk: med
- [ ] T08 Motion: springs on the compositor, reduced-motion honoured
  files: public/style.css, public/app.js
  check: no `transition: all`; animations touch only transform/opacity; new-session hint no longer animates width; prefers-reduced-motion disables them (harness asserts)
  after: T07
  risk: low
- [ ] T09 Probe: renderer cost in WebKit
  files: test/render-probe.py
  check: frame time p50/p95, forced layouts per frame, and snapshot apply time for the DOM grid vs xterm+WebGL on the same synthetic stream at iPad Pro 11; results and the chosen path recorded in Decisions
  after: T01
  risk: low
- [ ] T10 GPU grid rendering per T09
  files: public/app.js, public/style.css
  check: the path chosen in T09 ships; T09 probe re-run shows p95 frame time and forced layouts improved; mouse cell geometry still passes the T02 tap + drag checks
  after: T09, T06
  risk: high
- [ ] T11 Layout-thrash fixes on the grid path
  files: public/app.js
  check: cursor moves by transform, not a read after write; snapshots applied in rAF; session switcher diffs instead of rebuilding via innerHTML; cell probe cached; T09 forced-layout count drops
  after: T09
  risk: med
- [ ] T12 Full live run and the review pack for the operator
  files: package.json, .planning/ipad-apple-redesign.md
  check: T02 live harness green on the throwaway instance; one screenshot set (portrait, landscape, auth, settings, busy session) for operator review; version bumped to 4.0.0
  after: T02, T05, T08, T10, T11
  risk: low

## Open

## Log
