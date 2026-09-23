# iPad-first Liquid Glass redesign, herdr side pane, GPU rendering

## Why
The iPad client is not at "fine-tuning" quality: duplicated auth text, serif controls in Safari, a dark palette, a DOM-only grid renderer, and attention detection by regex (17.5% misses). Every iPad test ran in Chromium, never WebKit.
Goal: a state where the operator gives polish feedback, not structural feedback -- measured in a WebKit iPad simulator before any live use.
Appetite: L. No-gos: dark app chrome or a theme toggle, native app, phone-layout polish, a JS glass dependency, WebGL page snapshots, scrollback above the viewport, touching live 3456 before merge.

## Decisions
- D1 2026-09-22 App chrome is light only, one token set; the dark theme and its toggle are deleted, not hidden (operator rule).
- D2 2026-09-22 Liquid Glass = a CSS token layer in style.css (backdrop blur + saturate, tint, specular rim, soft shadow, continuous radii), recipe taken from liquid-glass-component-kit (MIT, credited) -- no JS dependency. Safari cannot refract live content (WebKit bug 245510, fix PR unmerged), so lens refraction is a later progressive enhancement, not part of this file.
- D3 2026-09-22 Glass is chrome only: side pane, toolbar, sheets, buttons, chips. The terminal is the opaque content layer underneath, monospace, a light terminal palette (dark text on a pale background; operator's choice 2026-09-22) -- per Apple's "no Liquid Glass in the content layer".
- D4 2026-09-22 System font stack (SF on iPad); no webfont, SF may not be embedded. Icons are self-drawn inline SVG in the SF Symbols style.
- D5 2026-09-22 Simulator = Playwright WebKit, iPad Pro 11 and iPad (gen 11) profiles. On Windows taps arrive as mouse events (maxTouchPoints=0); on-screen keyboard and pinch stay real-iPad checks.
- D6 2026-09-22 Two harness tiers: static (no server, synthetic session) gates every task; live runs on a throwaway 3457 with its own TOTP and herdr prefix, never 3456 or cm-0.
- D7 2026-09-22 Session status comes from herdr, not regex: one events.subscribe connection per cm-N pipe (pane.agent_status_changed), `agent list` poll as the fallback. States blocked/working/done/idle/unknown; done clears when viewed.
- D8 2026-09-22 Shortcuts mirror herdr's defaults: ctrl+b prefix, n/p/1-9 to switch, a next-needs-attention jump, a filterable ? overlay; plus a Cmd-K switcher for the iPad hardware keyboard.
- D9 2026-09-22 GPU work starts with a measured probe; the renderer decision follows the numbers.
- D10 2026-09-22 Any CSP change lands in server.js and test/static-server.js together.
- D11 2026-09-22 Keep the DOM grid renderer (T10: grid frame p95 33-36ms = xterm+WebGL 33ms at the WebKit floor, snapshots 2x faster; xterm as shipped runs on Canvas at p50 47ms because app.js calls onContextLost, not onContextLoss). T11 makes the grid compositor-friendly and fixes the WebGL fallback; a canvas grid renderer only if a real-iPad run shows paint-bound frames.

## Tasks
- [x] T01 WebKit iPad static harness with a screenshot baseline
  files: test/ipad-webkit.py, test/static-server.js
  check: WebKit at iPad Pro 11 portrait+landscape and iPad (gen 11); PNGs + metrics; exits non-zero on a console error or CSP violation; watched failing once
  risk: low
- [x] T02 Live WebKit harness against a throwaway 3457 instance
  files: test/ipad-webkit-live.py, scripts/throwaway-instance.ps1
  check: own worktree install (no node_modules junction), own TOTP and herdr prefix; sign-in, existing screen shown, tap moves pane focus, split drag resizes, typed echo, rotate, reconnect; teardown runs herdr session stop+delete; 3456 /health and cm-0 unchanged before vs after
  after: T01
  risk: high
- [x] T03 Login screen defects
  files: public/index.html, public/app.js, public/style.css
  check: one instruction line on the TOTP screen; controls render sans-serif in WebKit; screenshot diff reviewed
  after: T01
  risk: low
- [x] T04 Liquid Glass token layer, light only
  files: public/style.css, public/setup.html, public/app.js, public/index.html
  check: dark :root and .light overrides gone; 0 hardcoded colours outside the token block in style.css and setup.html; glass tokens applied to chrome only; theme-color meta at load
  after: T03
  risk: med
- [x] T05 Terminal as the content layer
  files: public/app.js, public/style.css
  check: one ANSI palette feeds grid and xterm; every colour meets WCAG AA 4.5:1 on the terminal background (harness asserts); terminal stays opaque, monospace, edge to edge under the glass
  after: T04
  risk: med
- [x] T06 herdr status feed on the server
  files: server.js, lib/session-backend/herdr.js, lib/herdr-events.js
  check: per-session status, cwd, worktree and title reach the client; a status change arrives within 2s (live harness); the subscription survives a herdr restart; the regex detector no longer decides attention on herdr
  after: T02
  risk: high
- [x] T07 herdr-style sessions side pane
  files: public/index.html, public/style.css, public/app.js
  check: one row per session with state, name, cwd, branch and title; rows update by diff, not innerHTML rebuilds; priority sort (blocked, done, working, idle); done clears on view; pinned in landscape, slide-over in portrait; targets >= 44pt; terminal area not smaller than today
  after: T04, T06
  risk: med
- [x] T08 Keyboard shortcuts and switcher
  files: public/app.js, public/index.html, public/style.css
  check: ctrl+b prefix keys, n/p/1-9, next-needs-attention, ? overlay with filter and Cmd-K switcher all pass in the harness; keys meant for the terminal still reach it; focus in/out sent when herdr asks (?1004h)
  after: T07
  risk: med
- [ ] T09 Controls and motion
  files: public/index.html, public/style.css, public/app.js, public/setup.html
  check: portrait side-pane sheet legible with no terminal text readable through it, even where backdrop blur is not drawn; landscape session names not truncated at typical lengths; settings as a glass sheet with iOS switches; input bar and chips restyled; a pointer click on Send works in hwkb mode (live step send-pointer passes, removed from known defects); setup.html scrolls; legacy Chromium harnesses (t04a, w2-ipad-verify, ipad-emulator) updated or retired with the reason recorded; no `transition: all`; animations touch only transform/opacity; prefers-reduced-motion disables them (harness asserts)
  after: T07
  risk: med
- [x] T10 Probe: renderer cost in WebKit
  files: test/render-probe.py
  check: frame time p50/p95, forced layouts per frame, snapshot apply time for DOM grid vs xterm+WebGL on one synthetic stream at iPad Pro 11; chosen path recorded in Decisions
  after: T01
  risk: low
- [x] T11 GPU terminal rendering and layout-thrash fixes
  files: public/app.js, public/style.css
  check: D11 ships; cursor by transform; snapshots in rAF; contain on the grid; xterm WebGL fallback engages (onContextLoss); T10 re-run shows p95 frame time and forced layouts down; tap + drag geometry still passes T02
  after: T10
  risk: high
- [ ] T12 Full live run and the review pack
  files: package.json, .planning/ipad-apple-redesign.md
  check: live harness green on the throwaway instance; one screenshot set (portrait, landscape, auth, side pane, settings, busy session) for operator review; version 4.0.0
  after: T05, T08, T09, T11
  risk: low

## Open

## Log
