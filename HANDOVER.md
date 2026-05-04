# HANDOVER -- Claude Mobile

Generated: 2026-05-04

## Decisions

- T24 cutover landed: grid is default; xterm is opt-out via `?renderer=xterm`. T26-T28 (delete legacy WS handler / drop xterm.js vendor / sweep CLAUDE.md) intentionally held to keep the fallback shipped indefinitely [verified in prod 3.2.18]
- Patch-only versioning on the 3.2.x line: 12 releases this session, no minor or major bump [verified -- git log]
- W7 closed with three concrete tasks (T30 substitute, T31, T33). T22 mouse tracking and T32 input-parser refactor explicitly skipped: low value vs cost on touch-only mobile [user call]
- Two-attempt cutover: first attempt (3.2.7, 2026-05-02) reverted same day. Eleven polish patches addressed real symptoms surfaced during soak before the retry (3.2.18) landed clean [verified]

## State Changes

- master HEAD = `8b3baf2` (T24 cutover, 3.2.18) [verified -- git log]
- PM2 running 3.2.18, online, all 3 dtach sessions recovered [verified -- pm2 list + audit log]
- 12 new commits this session: 3.2.7 reconnect fix -> 3.2.8 light-mode CSS -> 3.2.9 scroll-zones -> 3.2.10 palette+cursor+reverse -> 3.2.11 swipe -> 3.2.12 viewport culling -> 3.2.13 frame coalescing -> 3.2.14 ResizeObserver -> 3.2.15 touch-action -> 3.2.16 resize ground truth -> 3.2.17 inset gutter + fonts.ready -> 3.2.18 T24 flip
- New files: `memory/project_w6_history_render_bug.md` (post-mortem), `.planning/spike-w6-connect-probe.js`, `.planning/spike-w6-input-inject.js`, `.planning/spike-w6-browser-test.py`, `.planning/spike-w6-browser-single.py` (regression artifacts)
- `.planning/STATE-render-pipeline.yaml` rewritten: status: completed, wave 7/7, polish patches enumerated, retrospective added

## Discovered Constraints

- iOS Safari serves stale HTML across `pm2 restart` despite `Cache-Control: no-cache, no-store, must-revalidate`. Tab close + reopen busts; in-tab reload sometimes does not [observed during 3.2.6 -> 3.2.7 transition]
- iOS Safari probes char-width as fallback metrics if SF Mono / Menlo hasn't resolved at measurement time -- 7.13 px instead of 7.81 px, 5-col over-estimate. `document.fonts.ready` callback corrects this [verified -- 3.2.17]
- Multi-client PTY resize race: clients connected to the same session via different viewports each send their own resize. Last writer wins. Local lastCols cache desyncs from server truth; doResize must compare against `grid.cols` (snapshot ground truth) [verified -- 3.2.16]
- `touch-action: pan-y` is required on scroll containers under iOS; `auto` lets iOS evaluate horizontal pans first, breaking JS-driven swipe handlers [verified -- 3.2.15]
- ResizeObserver is the cheapest signal for "session became visible after being switched away" -- catches the display:none -> block transition that snapshots arriving while hidden mis-render against (clientHeight=0) [verified -- 3.2.14]

## Next Action

None blocking. Initiative is closed. Optional follow-ups when convenient:

- Drop `.planning/spike-headless-xterm.js`, `.planning/spike-w6-*` from working set (regression artifacts; safe to leave indefinitely)
- Delete the 5 merged feature branches still resident: `render-pipeline/{w1,w2,w3-w4,w5,w6}` (and likely a w7 branch from earlier)
- T26-T28 deletions if you ever decide grid mode is solid enough to drop the xterm fallback (would save ~400 KB shipped + ~100 LOC of legacy server handling)

## Context Pointers

- `.planning/STATE-render-pipeline.yaml` -- canonical project state, all polish patches enumerated, retrospective at the bottom
- `memory/project_w6_history_render_bug.md` -- post-mortem of the cutover bug
- `.planning/tech-design-render-pipeline.md` -- TypeSpec wire contract, EARS E1-E8 (unchanged)
- `.planning/plan-render-pipeline.md` -- task breakdown (unchanged; T22/T32 skipped, T30 substituted)
- `public/index.html` line 128: RENDERER_MODE polarity (default = grid, opt-out = xterm)
- `public/index.html`: search `gridTerms`, `applyGridSnapshot`, `applyGridFrame`, `renderGridWindow`, `queueGridFrame`, `mergeFrames`, `updateGridCursor`, `measureCharWidth`
- `public/style.css` line 240+: `.term-wrap` insets, `.grid-term` (touch-action, overscroll), `.grid-row`, `.grid-spacer`, `.grid-cursor`
- `server.js:1013-1110` (T02 coalescer + T12 headless mirror); `server.js:1638` (`ws.gridRenderer` flag set from connect msg); `server.js:1126-1175` (buildSnapshot, buildFrame, rowToRuns)
