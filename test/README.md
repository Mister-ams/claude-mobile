# test/ -- client and server harnesses

Current client harnesses (iPad-first, WebKit; see .planning/ipad-apple-redesign.md):

- `ipad-webkit.py` -- static gate. Playwright WebKit at the iPad profiles over
  `static-server.js` (production CSP, synthetic session). Gates every client
  task; `--self-test` must exit 1, `--baseline` refreshes `baseline/ipad-webkit/`.
- `ipad-webkit-live.py` -- live tier against a throwaway instance on 3457
  (`npm run sim:up`, `npm run test:ipad-live`, `npm run sim:down`). Never 3456.
- `render-probe.py` -- renderer cost probe (frame times, forced layouts).
- `herdr-events-verify.js` / `herdr-events-live.js` -- herdr status feed
  (`npm run test:herdr-events`).
- `repo-branch-verify.js` -- the git branch a session row shows, read from
  .git files without spawning git (`npm run test:repo-branch`).

Legacy Chromium harnesses (T09 decisions):

- `t04a-inline-handlers-verify.py` -- KEPT, updated: no inline handlers under
  the tight CSP, quick-bar double-fire guard and compose focus retention (incl.
  the Send mousedown guard). The deleted theme toggle is replaced by the
  settings open/Done pair.
- `w2-ipad-verify.py` -- KEPT, updated: key-to-byte map (Tab, Shift+Tab,
  atomic text+Enter), font size to PTY resize, swipe binding by width, no
  horizontal scroll across breakpoints. Cmd-J composes (Cmd-K is the switcher),
  the side pane replaces the tab strip, free port instead of 3462.
- `ipad-emulator.py` -- RETIRED. `ipad-webkit.py` does its job in the real
  engine (WebKit, iPad device profiles, synthetic snapshots, terminal-area
  metrics and PNGs) and gates it. Not carried over: its snapshot/resize
  content-shift probe, which measured the pre-T11 DOM grid in Chromium.
