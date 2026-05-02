# HANDOVER -- Claude Mobile

Generated: 2026-05-02

## Decisions

- Patch-only versioning on the 3.2.x line: every wave/release bumps the patch component only. `feedback_versioning.md` carries the rule [reported]
- W1-W5 use `@xterm/headless` v6.0.0 server-side as canonical VT engine; client cell-grid renderer consumes row-RLE diffs over WS [verified -- 13/13 spike checks + W5 commits in master]
- Coalesce numbers (server 16/4/64 ms, client one rAF) locked: user reported "huge improvement" after W1 [reported]
- T22 (mouse-tracking forwarding) deferred to W7: ~150 LOC, risks grid-mode UX, not commonly used in Claude Code REPL [observed]
- W6 default flip rolled back same day after history-render regression: keep grid as opt-in only until the bug is found [reported]

## State Changes

- master HEAD = `da4b2fc` (Revert "feat(T24)") [verified -- git log]
- PM2 running 3.2.6, online [verified -- pm2 list]
- 11 new commits this session: W1 (4) -> W2 (3) -> W3 (2) -> W4 (2) -> W5 (6) -> W6 (1 + 1 revert)
- New deps: `@xterm/headless@^6.0.0` (server-side VT mirror)
- New files: `.github/workflows/ci.yml` (syntax-only gate), `guide-tui-rendering-references.md`, `.planning/audit-fidelity-pre-w5.md`, `.planning/spike-report-headless-xterm.md`, `.planning/spike-headless-xterm.js`
- 5 feature branches merged into master via fast-forward and still resident locally + on origin: `render-pipeline/{w1,w2,w3-w4,w5,w6}` -- safe to delete

## Discovered Constraints

- xterm.js `term.write()` is async; callers reading buffer state must await the callback. T12 mirror is fire-and-forget which is correct (no synchronous reads after write) [verified -- spike script]
- `IBufferCell.getHyperlinkId()` is missing in @xterm/headless v6.0.0; use `cell.hasExtendedAttrs() !== 0` + per-session `parser.registerOscHandler(8, ...)` to track URIs by monotonic ID. Per-cell URI lookup uses the internal `line._line._extendedAttrs[x]._urlId` [verified -- probe + functional test]
- Frame messages do not carry cols/rows; resize requires emitting a fresh Snapshot to grid clients [observed]
- Grid scrollback is shipped as `RowChange[]` in Snapshot only; viewport-row scroll-off is not streamed -- next Snapshot delivers it (W7 polish)
- Grid history did NOT render when default-on, fine under opt-in flag (cause unknown) [reported]

## Next Action

Investigate why grid-mode history/scrollback fails to render when grid is the default but works under `?renderer=grid` opt-in. See `memory/project_w6_history_render_bug.md` for the four likely causes ranked. Until that's fixed, do NOT proceed to T26-T28 (deletions) or W7 polish.

## Context Pointers

- `.planning/tech-design-render-pipeline.md` -- 300 lines: TypeSpec wire contract, EARS E1-E8, 10 Y-statements
- `.planning/plan-render-pipeline.md` -- 33-task wave plan W1-W7
- `.planning/STATE-render-pipeline.yaml` -- updated with W5 closed and W6 attempted+reverted
- `.planning/spike-report-headless-xterm.md` + `spike-headless-xterm.js` -- W4 validation, OSC 8 workaround pattern
- `.planning/audit-fidelity-pre-w5.md` -- T05 baseline of WS path (zero filtering)
- `guide-tui-rendering-references.md` (root) -- OpenTUI + Claude Code CLI rendering analysis
- `server.js:1013-1110` (T02 coalescer + headless mirror), `server.js:1601-1614` (Snapshot on connect)
- `public/index.html` -- search `RENDERER_MODE`, `gridTerms`, `applyGridSnapshot`, `applyGridFrame`
- `memory/project_w6_history_render_bug.md` -- four ranked investigation paths for the bug
