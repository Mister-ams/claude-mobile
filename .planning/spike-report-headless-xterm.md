---
project: claude-mobile
type: audit
status: completed
created: 2026-05-02
updated: 2026-05-02
source: .planning/plan-render-pipeline.md (T13a, T14)
---

# Spike Report: @xterm/headless on the Server

W4 of render-pipeline. Validates **D3** (use `@xterm/headless` v6.0.0 on
the server, attached to dtach PTY, as the source of truth for the W5
cell-grid + row-diff transport). Verdict at the bottom.

## Method

Two layers:

1. **Scripted API validation** -- `.planning/spike-headless-xterm.js`,
   13 checks exercising every feature W5 depends on (plain text + cursor,
   colours, bold, alt-screen, DECSTBM scroll regions, cursor save/restore,
   OSC 8 hyperlinks, mouse tracking sequences, resize, 24-bit truecolour).
   Run via `node .planning/spike-headless-xterm.js`.
2. **Live mirror in production** -- T12 instantiates a headless terminal
   per session in `server.js`, mirroring every `proc.onData` chunk into it
   alongside the existing client broadcast. Not wired to clients yet --
   inspection only via `dumpHeadlessGrid(id)`. Live byte-for-byte parity
   against the xterm.js client is the user's part; see "Live validation
   procedure" below.

## Scripted findings

```
13 pass / 0 fail (13 total)
```

All API surface W5 needs is supported. Two workarounds documented below;
neither blocks.

### Workaround 1: `term.write()` is async

Every `term.write(data)` returns immediately and parses on the next
microtask. Synchronous reads of the buffer after a write see stale state.
The spike script uses a `writeAsync(t, data)` Promise wrapper that resolves
in the write callback.

**Production impact**: T12's mirror in `server.js` (line ~1067) is
fire-and-forget -- which is correct for our use because we never
synchronously read the buffer after a write in production. `dumpHeadlessGrid`
is invoked by humans, hundreds of ms after the last byte arrived, well
after the parse queue drains. No code change needed.

### Workaround 2: OSC 8 URI access via `parser.registerOscHandler`

`IBufferCell` in v6.0.0 does **not** expose `getHyperlinkId()`. Probing
showed:

- `cell.hasExtendedAttrs()` returns `268435456` (= `0x10000000`) for
  cells inside an OSC 8 hyperlink, `0` for plain cells. Usable as a
  "this cell is part of a link" boolean signal.
- `terminal.parser.registerOscHandler(8, fn)` fires on every OSC 8
  sequence (opener and closer). The opener payload is `;<URI>`, the
  closer is `;`. Both pass through the same handler.

**W5 implementation pattern**: per session, register an OSC 8 handler at
headless init. Maintain `currentLinkUri` state. On each handler fire,
parse the payload (`;` => closer, `;<uri>` => opener with URI). When
emitting cell-grid rows for the diff transport, attach `currentLinkUri`
to each cell that has `hasExtendedAttrs() !== 0`. Cost: ~30 lines of
state-tracking code.

## Live validation procedure (user's part)

The scripted checks confirm headless can parse what it needs to. The
remaining question is byte-for-byte parity against the live xterm.js
client during real Claude Code REPL + Bash + vim + htop sessions.

To compare:

1. With render-pipeline/w3-w4 deployed (PM2 running 3.2.5), open a
   session and use Claude / vim / htop / ls --color etc.
2. From the WSL box, drop into the running Node process (or add a temp
   debug command -- see "Future debug surface" below) and call
   `dumpHeadlessGrid(0)` (or whichever session id).
3. Compare the returned `text` field against the visible xterm.js
   viewport on the phone. Expected: identical printable content; subtle
   differences in trailing whitespace are OK.

This is judgment-based, not byte-exact -- the goal is "no surprises in
common usage", not "every cell matches every byte".

## Future debug surface (deferred; not part of this push)

Today `dumpHeadlessGrid(id)` is callable only from inside the Node
process. To make user-driven validation easier, a small debug WS message
type (gated by `config.enableHeadlessDump`) would let the phone request
the dump from the server and display it. Out of scope for the spike --
W5 will introduce a real client cell renderer that consumes the same
cell grid, making this debug shortcut redundant.

## Verdict

**GO for W5.** All required ANSI / OSC / DECSET behaviour is supported
or has a documented, low-cost workaround. The two workarounds (async
writes, OSC 8 handler) are already designed into the W5 plan via the
TypeSpec `hyperlink` field and the row-diff emission cadence.

Risks remaining for W5:

- **Mouse-tracking encoding**: scripted check confirmed `\x1b[?1000h`
  and `\x1b[?1006h` are accepted without throw, but headless does not
  emit mouse responses (no input source). The client cell renderer in
  W5 will need to encode pointer events into mouse-tracking sequences
  itself and send via the existing Input WS message. Tracking state
  (which mode the CLI requested) needs to be exposed -- probably via a
  custom CSI handler analogous to OSC 8, or by parsing the dtach byte
  stream server-side in parallel. Defer the implementation choice to
  W5 detailed design.
- **Diff cost on alt-screen redraws**: headless re-renders the whole
  buffer when the CLI emits a full-frame redraw (vim ":redraw!", htop
  refresh). The diff builder will ship most of the screen as changed
  rows. Acceptable on mobile per `tech-design-render-pipeline.md`
  Integration Risks; revisit in W7 if profiling shows otherwise.
