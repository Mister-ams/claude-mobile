---
project: claude-mobile
type: guide
status: active
created: 2026-05-01
updated: 2026-05-01
---

# Guide: TUI Rendering References

Reference notes on external TUI/terminal renderers worth studying for
claude-mobile's v3 hardening and v4 thin-viewer design. Focus is rendering
smoothness, streaming behaviour, and mobile-applicable techniques.

ASCII only. Update this file when a new reference is reviewed.

---

## sst/opencode + sst/opentui

Reviewed 2026-05-01.

### What it is

`sst/opencode` is the SST coding agent CLI. It ships two TUIs:

- Legacy Go TUI (Bubble Tea + Lipgloss + Bubbles + glamour). Feature-complete
  but no longer the active path.
- Current TypeScript TUI at `packages/opencode/src/cli/cmd/tui/`, built on
  SolidJS + `@opentui/solid` + `@opentui/core`.

`@opentui/core` is a separate library (`sst/opentui`). It is a TS reconciler
in front of a Zig rendering core called via FFI. The Zig side is where the
interesting techniques live.

### Architecture in one paragraph

Components describe a UI tree. The reconciler renders into a "next" cell-grid
buffer. The Zig core diffs next-vs-current at the cell level, RLE-collapses
adjacent cells with identical SGR state into one ANSI sequence, and writes
only changed runs. Rendering is driven by `requestRender()`, which is debounced
and dirty-flagged so rapid state churn coalesces into one frame. A
`requestLive()`/`dropLive()` ref-count gates a continuous render loop so it
runs only while a stream or animation is active and idles to 0 Hz otherwise.

### Streaming model (most relevant to claude-mobile)

OpenTUI handles LLM streaming via `ScrollbackSurface`:

- A rope-backed `unified_text_buffer.zig` allows append-on-stream without
  reallocation. Virtual-line recalc is done only at the tail.
- Each token tick re-renders the volatile tail in place. No flicker because
  the diff only emits changed cells.
- `settle()` waits for tree-sitter highlighting to finish, then `commitRows`
  publishes finished rows into permanent scrollback. Committed rows are
  immutable and never re-rendered.

Net effect: the assistant's "in-progress" output is freely re-rendered while
streaming; once a row settles, it's frozen above the cursor and out of the
render path.

### Frame loop modes

| Mode        | Trigger                                              | Use                |
|-------------|------------------------------------------------------|--------------------|
| Automatic   | Render only when component tree changes              | Default            |
| Continuous  | `start()` runs at `targetFps` (default 30 Hz)        | Fullscreen TUIs    |
| Live        | Ref-counted via `requestLive`/`dropLive`             | Streams, spinners  |

`maxFps` caps bursts. `requestRender` debounces inside one frame.

### Other transferable techniques

- **Cell-grid diff + RLE.** Keep a cell array model server-side; ship clients
  only changed runs (char + style + run-length) instead of raw ANSI bytes.
  Smaller payloads, no client parser cost.
- **Viewport culling.** `ScrollBoxRenderable` does scissor + scrollY/scrollX
  so only visible lines are rendered. The web equivalent is mounting only
  visible rows + small overscan in the DOM.
- **Single-layer input parser.** ANSI, modifyOtherKeys, Kitty Keyboard
  Protocol, bracketed paste, and IME all pass through one input handler
  chain in `packages/core/src/lib/input/`. No protocol logic leaks into
  components.
- **Style/emit separation.** Theme JSON resolves to RGBA per cell on the TS
  side; ANSI emission with RLE is one tight pass on the Zig side. Decide
  colours in app code; emit bytes in one place.

### Key file paths

- TUI app: `sst/opencode` -> `packages/opencode/src/cli/cmd/tui/`
  - `app.tsx`, `event.ts`, `layer.ts`, `thread.ts`
  - `context/theme.tsx` (theme JSON -> runtime RGBA)
- Rendering core: `sst/opentui` -> `packages/core/src/...` (TS) and Zig
  files: `renderer.zig`, `ansi.zig`, `unified_text_buffer.zig`
- Input: `packages/core/src/lib/input/`
- Background reading: issue `sst/opencode#3731` documents OpenTUI theme
  architecture.

### What to steal for claude-mobile

Ranked by impact-per-effort.

1. **Coalesced streaming writes.** Buffer `proc.onData` server-side for
   ~16 ms or 4 KB before sending. On the client, queue `output` messages
   and flush via one `requestAnimationFrame` per frame. Today every PTY
   chunk passes through encrypt -> WS -> xterm parser one-to-one.
2. **Live-counter render loop.** Run a single rAF loop only while a WS
   stream or animation is active. Idle to 0 Hz. Battery win on mobile.
3. **Cell-grid + row-level RLE diffs as v4 transport.** Run a headless VT
   parser on the server against the dtach-attached PTY, maintain a cell
   grid, and emit row-level RLE diffs. Eliminates client-side ANSI parsing
   (drop xterm.js, ~480 KB saved), gives full server-side scrollback,
   reconnect = snapshot, no tmux needed (unblocks v4).
4. **Rope tail + commit-on-settle.** A "live tail" DOM node (last N rows,
   freely re-rendered per frame) plus a "frozen" parent that only appends
   finalised rows. Maps onto the v4 cell-grid transport.

Lower priority: viewport culling for scrollback DOM; single bracketed-paste
and IME parser layer instead of touch-handler whack-a-mole on mobile.

### What does NOT transfer

- The Zig FFI layer. We're not adopting Zig; the technique transfers, the
  implementation does not.
- The SolidJS reconciler shape. Our viewer is hand-rolled vanilla JS in
  `public/index.html`; introducing a reconciler is out of scope.

---

## codeaashu/claude-code

Reviewed 2026-05-01. The repo is an archive of leaked Anthropic Claude Code
CLI source (Bun runtime, TS strict, React 19). Studied for CLI-fidelity, not
for web-terminal mechanics (it has none).

### One-sentence frame model

**Full-screen TUI** (alt-screen + DECSTBM scroll region + per-frame
damage-tracked diff repaint), much closer to vim/htop than to a chat REPL
with inline scrollback.

### What that means in detail

- **Vendored Ink fork.** No npm `ink` dependency. The Ink-equivalent layer
  lives at `src/ink/` (40+ files: `reconciler.ts`, `renderer.ts`, `dom.ts`,
  `screen.ts`, `log-update.ts`, `optimizer.ts`, `parse-keypress.ts`,
  `termio/csi.ts`). API parity with Ink (`Box`, `Text`, `useInput`) but a
  rewritten renderer.
- **No `<Static>` component.** Ink's append-once log channel was deliberately
  dropped. Every previously-rendered message is part of the React tree and
  goes through diffing on every frame. The CLI never relies on
  "previous output is immutable above the cursor."
- **Alt-screen on mount.** `src/ink/components/AlternateScreen.tsx` writes
  `\x1b[?1049h\x1b[2J\x1b[H` on mount and `\x1b[?1049l` on unmount, plus
  optional mouse tracking. The whole REPL is wrapped in `<AlternateScreen>`.
- **DECSTBM + relative cursor moves.** `csi.ts` exports
  `setScrollRegion(top, bottom)`, save/restore cursor, relative
  `cursorUp/Down/Forward/Back`, and `eraseLines(n)`. `log-update.ts` does
  diff-based incremental cursor-driven repainting with hardware scroll
  regions when content shifts -- not clear-and-reprint.
- **Cursor anchoring per frame.** `Ink.onRender` prepends `CURSOR_HOME` and
  appends `cursorPosition(rows, 1)` every frame in alt-screen mode --
  self-healing against any external cursor manipulation.
- **Damage-tracked virtual screen.** `src/ink/screen.ts` is a packed Int32
  cell buffer with a damage bounding rect. `log-update.ts` diffs prev vs
  next VirtualScreen and emits relative cursor moves, scroll-region
  changes, per-line erase, growth `\r\n`, batched into a single
  `process.stdout.write`.
- **Streaming markdown is split-buffer.** `src/components/Markdown.tsx`
  ships `StreamingMarkdown` which keeps a `stablePrefix` (complete markdown
  blocks, in `useRef`) and an `unstableSuffix` (the trailing in-progress
  block). Per token delta, only the suffix re-lexes; the stable prefix's
  React subtree stays memoised. Same idea as OpenTUI's commit-on-settle.
- **Spinners use `useAnimationFrame(120)`.** No `cli-spinners` dep.
  Animation lives in a child component to keep parents off the per-frame
  clock.
- **Tool-call rendering is full inline by default**, with collapsed
  variants for Read/Search results (`CollapsedReadSearchContent.tsx`).
  Bash streams via `OutputLine.tsx` + `ShellProgressMessage.tsx`.
- **Sticky-bottom prompt is a Yoga layout property**, not a cursor trick.
  `flexShrink=0 maxHeight=50%` on the prompt region; the message history
  uses a `<ScrollBox stickyScroll>` above it. Every keystroke triggers a
  full layout pass and the renderer diffs the whole frame.

### What the CLI emits on the wire

- `\x1b[?1049h` / `\x1b[?1049l` (alt-screen enter/exit)
- `\x1b[?1000h` / `\x1b[?1006h` family (mouse tracking)
- `\x1b[r` / `\x1b[<top>;<bot>r` (DECSTBM scroll regions)
- `\x1b[<n>A/B/C/D` (relative cursor moves)
- `\x1b[<n>K`, `\x1b[2J`, `\x1b[3J` (erase line / display / scrollback)
- `\x1b[s` / `\x1b[u` (save/restore cursor)
- OSC 8 hyperlinks (`\x1b]8;;url\x1b\\text\x1b]8;;\x1b\\`)
- Full SGR colour set, true colour

### What this means for claude-mobile

- **A pure ANSI-to-HTML pipeline (the original v4 plan) cannot work.** The
  viewer needs a real VT emulator. Replacing xterm.js with a regex-based
  ANSI converter would silently break alt-screen, DECSTBM, mouse, and
  cursor-relative repaints within seconds of the first Claude turn.
- **Alt-screen support is mandatory.** Without `DECSET 1049` honored, the
  REPL renders nothing to the visible scrollback. xterm.js handles this
  natively; v4 must too.
- **The byte stream must pass through unmodified.** No sequence filtering,
  no pretty-printing, no reflow. Treat dtach output as opaque.
- **Resize must be wired immediately.** `Ink.handleResize` re-anchors the
  cursor and reflows the Yoga tree on every `SIGWINCH`. Wrong PTY size =
  clipped messages or doubled prompt rows. Viewer resize must
  `TIOCSWINSZ` the dtach PTY immediately; debounce only client-side.
- **Mouse tracking and OSC 8 should pass through.** Mouse for
  ScrollBox/selection inside the CLI; OSC 8 turns file paths into
  clickable links in `Markdown.tsx`. xterm.js supports both -- opt them
  in. Don't layer a browser scrollbar on top; the CLI owns scrolling.

### Implication for v4 architecture

This forces a different v4 shape than originally planned. The cell-grid +
row-diff transport idea from OpenTUI still applies, but the implementation
must include a faithful VT emulator on the server, not an ANSI-to-HTML
filter.

Concretely: run a headless xterm (e.g. `@xterm/headless`) on the server
attached to the dtach PTY. Maintain a cell grid in memory. Emit row-level
RLE diffs to the client. Reconnect = send the current cell grid as a
snapshot. The client renders the cell grid (DOM or canvas), without
running its own VT. Drops the client-side ANSI parsing (which is where
parser-corruption bugs originate) without losing any of the alt-screen /
DECSTBM / mouse fidelity.

The original v4 tmux `capture-pane` design fails on this requirement:
capture-pane returns a screen snapshot but does not preserve the
sequence-stream semantics the CLI depends on for mouse, OSC 8, and
streaming markdown coalescing. It also re-introduces the tmux dependency
the project moved away from in v3.1.3.

### What does NOT transfer

- Vendoring a custom React reconciler. We render a viewer, not a TUI; we
  don't need React-on-terminal.
- The whole streaming-markdown stable-prefix / unstable-suffix split. That
  lives inside the CLI process itself; we receive the rendered output
  via the PTY.
