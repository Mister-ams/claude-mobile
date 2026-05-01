---
project: claude-mobile
type: spec
status: active
created: 2026-03-23
updated: 2026-05-01
source: (conversation-driven -- guide-tui-rendering-references.md)
inherited_from: none
---

# Technical Design: Render Pipeline

## Overview

Replace the raw-byte WS + client-side xterm.js pipeline with a server-side
@xterm/headless cell grid streamed to the client as row-level RLE diffs,
delivered as 7 incremental waves on the 3.2.x patch line. Preserves Claude
Code CLI fidelity (alt-screen, DECSTBM, mouse, OSC 8) while eliminating
client-side ANSI parsing, parser-corruption bugs, and the ~480 KB xterm.js
client bundle.

## Inherited Context

- Source: conversation 2026-05-01, grounded by `guide-tui-rendering-references.md`
  (OpenTUI study + Claude Code CLI rendering analysis).
- Inherited: 0 files, 0 endpoints, 0 constraints from formal PRD.
- **Delta from fresh scan**: zero -- all citations verified live in this session.

## Current State

- **Renderer**: vendored `@xterm/xterm` v5.5.0 + addon-webgl + addon-canvas.
  `public/index.html:856-870` (`makeTerm`), `public/vendor/xterm.min.js`
  (~283 KB) + addons (~195 KB).
- **Transport**: WSS, AES-256-GCM frames over `ws` v8.18.0. Per-message JSON.
- **Hot path (no coalescing)**: PTY chunk -> `secureSend(output)` -> client
  `term.write` per message. `server.js:1013-1047`, `public/index.html:771-788`.
- **Scrollback**: 400 KB raw-byte string ring buffer (`server.js:1015-1022`),
  10 000-line xterm.js client buffer (`makeTerm` `scrollback: 10000`).
  Reconnect replays the entire string in 50-line chunks
  (`public/index.html:789-808`).
- **PTY**: `node-pty` v1.0.0 spawns `wsl.exe` -> `dtach -a /tmp/cm-{id}.dtach`
  (`server.js:107-128`). dtach socket survives PM2 restart.
- **package.json drift**: declares `"version": "3.1.5"` while the live
  release is 3.2.1. Reconcile in W1.

## Target State

### System Design

```
                                            +-------------------------+
   dtach PTY  -- raw bytes -->  node-pty -->| @xterm/headless         |
   (WSL)         (server.js)                | (in-process, server)    |
                                            |   - cell grid           |
                                            |   - alt-screen buffer   |
                                            |   - scrollback (5000 r) |
                                            +-----------+-------------+
                                                        |
                                          onWriteParsed / onCursorMove
                                                        v
                                            +-------------------------+
                                            | Diff builder            |
                                            |   - prev vs next grid   |
                                            |   - row-level RLE       |
                                            +-----------+-------------+
                                                        |
                                                AES-256-GCM WS frame
                                                        v
                                            +-------------------------+
                                            | Client cell renderer    |
                                            |   - DOM rows of spans   |
                                            |   - one rAF per frame   |
                                            +-------------------------+
                                                        |
                                              pointer / key events
                                                        v
                                            input message  --(WS)-->  pty.write
```

### API Contracts

Single-consumer (only this project's web client). Wire contract is the WS
protocol; included as TypeSpec for unambiguous reference.

```typespec
namespace ClaudeMobile.RenderPipeline;

model SgrState {
  fg?: int32;          // ANSI 256 index or 0xRRGGBB (>= 1<<24 means 24-bit)
  bg?: int32;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
  hyperlink?: string;  // OSC 8 URI, if any
}

model CellRun { text: string; sgr: SgrState; length: int32; }
model RowChange { row: int32; runs: CellRun[]; }   // negative row = scrollback
model Cursor { row: int32; col: int32; visible: boolean; }

@discriminator("type")
union ServerToClient {
  Snapshot,
  Frame,
}

model Snapshot {
  type: "snapshot";
  session: string;
  cols: int32; rows: int32;
  viewport: RowChange[];      // 0..rows-1
  scrollback: RowChange[];    // up to 5000 rows, row indices negative
  cursor: Cursor;
  altScreen: boolean;
  mouseTracking: boolean;
  seq: int64;
}

model Frame {
  type: "frame";
  session: string;
  changes: RowChange[];
  cursor: Cursor;
  seq: int64;                 // monotonic per session
}

@discriminator("type")
union ClientToServer { Input, Resize }
model Input  { type: "input"; session: string; data: string; }
model Resize { type: "resize"; session: string; cols: int32; rows: int32; }
```

### Behavioral Contract

- WHEN the dtach PTY emits output IF the new pipeline is active THE server
  SHALL update the headless cell grid before emitting any client frame.
- WHEN a client connects or reconnects to a session THE server SHALL send a
  Snapshot containing the full viewport plus up to 5000 scrollback rows
  before any Frame.
- WHEN the cell grid contains no diff since the last emission THE server
  SHALL NOT emit a Frame.
- WHEN the client emits Resize IF cols in [10,400] AND rows in [5,200]
  THE server SHALL apply TIOCSWINSZ to the dtach PTY before the next Frame.
- WHEN the CLI emits DECSET 1049 (alt-screen enter) THE next Snapshot or
  Frame SHALL reflect alt-screen contents and altScreen=true.
- WHEN the CLI emits an OSC 8 hyperlink THE cell grid SHALL preserve the URI
  on affected cells AND the client SHALL render them as anchors.
- WHEN mouse tracking is active (DECSET 1000/1006) THE client SHALL forward
  pointer events as mouse-tracking escape sequences via Input.
- WHEN a backgrounded tab returns to the foreground THE client SHALL request
  a fresh Snapshot and discard any buffered frames.

### Data Model

In-memory only. No DB.

- `session.grid: HeadlessTerminal` (one per session, via `@xterm/headless`).
- `session.scrollbackRows: RowChange[]` capped at 5000 rows; replaces the
  400 KB string ring buffer at `server.js:1015`.
- `session.lastEmittedGrid: Cell[][]` for diff comparison.
- `session.frameSeq: number` monotonic.

## Key Decisions

- **D1 (W1)**: In the context of every PTY chunk hitting encrypt+WS+parser
  one-to-one, facing iOS streaming jitter, we decided to coalesce
  `proc.onData` server-side (16 ms timer / 4 KB byte cap / 64 ms max-age)
  to achieve smoother streaming and fewer WS frames, accepting <=16 ms
  added latency on bursty output. **locked**.
- **D2 (W1)**: In the context of `term.write` per WS message thrashing the
  xterm.js parser, we decided to queue incoming Output messages on the
  client and flush via one rAF per frame, accepting one frame of added
  perceived latency. **locked**.
- **D3 (W4)**: In the context of needing CLI fidelity without client-side
  ANSI parsing, we decided to adopt `@xterm/headless` (the same VT engine
  already vendored client-side) on the server, accepting one new server
  dep. **locked**.
- **D4 (W5)**: In the context of streaming a cell grid efficiently, facing
  the choice of full snapshots, cell diffs, or row diffs, we decided on
  row-level RLE diffs (`{row, runs:[{text,sgr,length}]}`), accepting that
  cross-row optimisations are W7 polish. **locked**.
- **D5 (W5)**: In the context of emission cadence, we decided event-driven
  (xterm `onWriteParsed`/`onCursorMove` -> diff -> emit if non-empty)
  with snapshot on (re)connect, accepting no polling-induced latency
  floor. **locked**.
- **D6 (W5)**: In the context of safe rollout, we decided per-session
  feature flag (URL param `?renderer=grid` + settings toggle), default
  off, accepting some duplicated message-handling code during W5.
  **locked**.
- **D7 (W6)**: In the context of cutover, we decided binary default flip
  after manual smoke covering Claude Code REPL + Bash + vim/htop on >=5
  sessions, accepting that "soak" is judgment-based at this scale.
  **locked**.
- **D8 (W5)**: In the context of replacing the byte ring buffer, we
  decided to cap cell-grid scrollback at 5000 rows per session, accepting
  truncation of very long sessions (matches current behaviour).
  **locked**.
- **D9 (W5)**: In the context of resize, we decided client debounce 100 ms
  -> WS Resize -> server TIOCSWINSZ on dtach PTY -> `headlessTerm.resize`
  -> next Frame, accepting 1-2 intermediate frames during rapid gestures.
  **locked**.
- **D10 (process)**: Versioning is patch-only on the 3.2.x line. Each
  wave lands as 3.2.N. The "v4" label is dead. **locked**.

## Boundary Map

| # | Producer | Consumer | Contract | Fields/Shape | Direction |
|---|---|---|---|---|---|
| 1 | dtach PTY | server `proc.onData` | raw bytes (TERM=xterm-256color) | Buffer | stream |
| 2 | server | `@xterm/headless` | `term.write(chunk)` | string/Uint8Array | call |
| 3 | `@xterm/headless` | diff builder | `onWriteParsed`, `onCursorMove`, buffer cells | event + cell grid | event |
| 4 | server | client | WS Snapshot \| Frame (TypeSpec above) | encrypted JSON | response |
| 5 | client | server | WS Input \| Resize | encrypted JSON | request |
| 6 | server | dtach PTY | `proc.write(data)`, `proc.resize(cols,rows)` | string, ints | call |

### Integration Risks

- **`@xterm/headless` parity**: must support OSC 8, DECSTBM, mouse modes
  used by Claude Code. Validated in W4 spike before W5 commits.
- **Diff cost on full-frame redraws**: alt-screen TUIs (vim, htop) can
  invalidate the whole grid; row-level diff still ships the full screen
  but is bounded by `cols*rows` cells. Acceptable on mobile; revisit if W7
  finds otherwise.
- **OSC 8 round-trip in cell metadata**: `@xterm/headless` exposes link
  data via the buffer line API; confirm in W4 we can read it without
  monkey-patching internals.
- **Encryption framing overhead**: each Frame is one AES-256-GCM message;
  unchanged from v3.

## Unknowns / Spikes

- **W4 spike (D3 validation)**: stand up `@xterm/headless` against a live
  dtach session, confirm correct rendering of Claude Code REPL +
  alt-screen (vim) + mouse tracking + OSC 8. Output: spike report at
  `.planning/spike-report-headless-xterm.md`. Go/no-go gate for W5.

## Verification Strategy

- [ ] **W1**: under sustained Claude streaming (1k tokens), WS message
  count drops by >=4x; iOS streaming visibly smoother; no regression in
  TUI cursor handling (vim/htop still render correctly through the
  unchanged xterm.js client).
- [ ] **W2**: alt-screen, DECSTBM, mouse, OSC 8, relative cursor moves
  all currently work end-to-end on v3 (audit the WS path for sequence
  filtering; expect none).
- [ ] **W3**: client rAF loop runs only while WS messages or animations
  are active; idle CPU <=1% on phone.
- [ ] **W4 spike**: headless xterm reproduces the visible output of a
  live Claude Code session byte-for-byte against the existing client.
- [ ] **W5**: feature-flagged sessions render Claude Code REPL, Bash
  output, vim, htop indistinguishably from the xterm.js client; OSC 8
  links clickable; resize within 100 ms of pointer-up.
- [ ] **W6**: default-on for >=24 h with no fidelity regressions; xterm.js
  vendored files removed; client bundle delta confirmed.
- [ ] **W7**: rope-tail / commit-on-settle reduces DOM mutation on
  streaming markdown; viewport culling caps mounted rows at
  visible+overscan.

## Affected Files

| File | Action | Change |
|---|---|---|
| `server.js` | modify | W1: coalesce `proc.onData` (lines 1013-1047). W4-W5: introduce `@xterm/headless` per session, diff builder, Snapshot/Frame senders. W6: remove raw `output` and `scrollback` paths. |
| `public/index.html` | modify | W1: rAF batching of `term.write`. W3: live-counter loop. W5: cell-grid renderer behind flag. W6: remove xterm.js mount. |
| `public/vendor/xterm.min.js` | delete (W6) | After cutover. |
| `public/vendor/xterm.min.css` | delete (W6) | -- |
| `public/vendor/addon-fit.min.js` | delete (W6) | -- |
| `public/vendor/addon-webgl.min.js` | delete (W6) | -- |
| `public/vendor/addon-canvas.min.js` | delete (W6) | -- |
| `package.json` | modify | W1: bump `version` 3.1.5 -> 3.2.2 (drift fix). W4: add `@xterm/headless`. |
| `CLAUDE.md` | modify | Update architecture each wave; W6 removes xterm.js gotchas. |
| `.planning/spike-report-headless-xterm.md` | create (W4) | Output of D3 validation. |

## Implementation Sequence

1. **W1 -- Coalesce (3.2.2)**: server-side onData buffer + client rAF batch.
   No architecture change. Reversible by reverting one commit.
   - Deliverable: smoother streams; >=4x WS frame reduction under Claude
     output.
2. **W2 -- Fidelity audit + resize wire (3.2.3)**: confirm the v3 WS path
   filters no sequences; wire `Resize` -> `proc.resize` immediately.
   - Deliverable: documented fidelity baseline + responsive resize.
3. **W3 -- Render loop (3.2.4)**: client-side `requestLive`/`dropLive`
   ref-counted rAF loop replacing scattered timers and rAF calls.
   - Deliverable: idle CPU near zero on the phone.
4. **W4 -- Headless xterm spike (3.2.5)**: stand up `@xterm/headless`
   server-side off the live dtach PTY, validate full fidelity, write spike
   report. No user-visible change.
   - Deliverable: go/no-go on W5; spike report committed.
5. **W5 -- Diff transport behind flag (3.2.6)**: implement Snapshot + Frame
   wire, server diff builder, client cell-grid renderer; per-session opt-in
   flag; both pipelines coexist.
   - Deliverable: feature-flagged new viewer; xterm.js still default.
6. **W6 -- Cutover (3.2.7)**: flip default to grid renderer; after >=24 h
   clean, remove raw `output`/`scrollback` paths and xterm.js vendor files.
   - Deliverable: ~480 KB client bundle drop; no client-side ANSI parsing.
7. **W7 -- Polish (3.2.8)**: rope-tail / commit-on-settle in renderer;
   viewport culling; single bracketed-paste/IME parser layer.
   - Deliverable: reduced DOM mutation; bounded mounted rows.
