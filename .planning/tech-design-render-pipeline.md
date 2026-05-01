---
project: claude-mobile
type: spec
status: draft
created: 2026-03-23
updated: 2026-03-23
source: (conversation-driven -- no formal requirements doc)
---

# Technical Design: v4.0 Thin Viewer Architecture

## Overview

Replace xterm.js terminal emulation with a server-rendered thin viewer. The server
periodically captures tmux's rendered pane (capture-pane with ANSI colors), converts
to HTML, and sends frames to the phone. The phone displays pre-rendered HTML in a
scrollable monospace div. Input continues via pty.write() through the existing
node-pty attachment. This eliminates all cursor-sequence rendering bugs and gives
full tmux scrollback history on resume.

## Current State

- `server.js` (1667 lines): Express + WS + node-pty + tmux management + E2E crypto
- `public/index.html` (2152 lines): Single-file client with xterm.js, Palantir theme
- Rendering: raw pty stream -> WebSocket -> xterm.js parses ANSI client-side
- Scrollback: xterm.js buffer (volatile, lost on PWA kill). tmux has no TUI history.
- Input: pty.write() via attached wsl.exe process
- Session persistence: tmux in WSL survives PM2 restarts
- Key files: `public/vendor/xterm.min.js` (283KB), `addon-fit` (1.8KB),
  `addon-webgl` (99KB), `addon-canvas` (93KB)

## Target State

### System Design

```
tmux (WSL)                    server.js                     phone (index.html)
  |                              |                              |
  | Claude Code runs here        |                              |
  | Full scrollback history      |                              |
  |                              |                              |
  |<-- capture-pane 100ms -------|                              |
  |     (rendered text + ANSI)   |                              |
  |                              |-- ANSI-to-HTML convert ----->|
  |                              |-- diff against last frame -->|
  |                              |-- send changed lines ------->| display in
  |                              |                              | monospace div
  |                              |                              |
  |                              |<-- text input (pty.write) ---|
  |<-- pty forwards to tmux -----|                              |
```

### Rendering Pipeline

1. Server: `setInterval(100ms)` per session with active clients
2. Server: `tmux capture-pane -t ${name} -p -e -J -S -500` (visible + 500 lines history)
3. Server: split into lines, compare against `session.lastFrame` (line array)
4. Server: convert changed lines from ANSI to HTML spans
5. Server: `secureSend(ws, { type: 'frame', session, changes: [{row, html}] })`
6. Client: update corresponding `<div>` lines in the scrollable container
7. On connect: full frame sent (all lines)

### ANSI-to-HTML Conversion

Server-side function. Parses SGR sequences (colors, bold, underline) into CSS classes:

```
\x1b[31m  ->  <span class="c1">   (red foreground)
\x1b[1m   ->  <span class="b">    (bold)
\x1b[0m   ->  </span>             (reset)
```

16 foreground + 16 background + bold/underline/italic. CSS classes defined in
index.html matching the Palantir theme colors (dark + light mode).

No cursor positioning to handle -- capture-pane strips it.

### Message Protocol Changes

| Message | Direction | Old (v3) | New (v4) |
|---------|-----------|----------|----------|
| output | S->C | `{type:'output', data: rawPty, seq}` | REMOVED |
| scrollback | S->C | `{type:'scrollback', data: capturePane}` | REMOVED |
| scrollback-chunk | S->C | `{type:'scrollback-chunk', data, seq, total}` | REMOVED |
| scrollback-end | S->C | `{type:'scrollback-end'}` | REMOVED |
| sync | S->C | `{type:'sync', data: visiblePane}` | REMOVED |
| frame | S->C | -- | `{type:'frame', session, changes:[{row,html}]}` |
| full-frame | S->C | -- | `{type:'full-frame', session, lines:[html], total}` |
| input | C->S | `{type:'input', data}` -> `proc.write(data)` | UNCHANGED |
| create | C->S | sends cols/rows | cols only (rows managed by tmux) |
| resize | C->S | `{type:'resize', cols, rows}` | REMOVED (tmux manages size) |
| sessions, auth, etc | both | unchanged | UNCHANGED |

### Input Handling

Keep pty.write() via the attached wsl.exe process. No change to input path.

Quick actions map to the same escape sequences:
- Clear: `\x1b[F` + 500x backspace
- Esc: `\x1b`
- Up: `\x1b[A`
- Down: `\x1b[B`
- Send: text + `\r`

## Key Decisions

| # | Decision | Chosen | Status | Rationale |
|---|----------|--------|--------|-----------|
| 1 | Capture poll rate | 100ms (10fps) | locked | Responsive feel when Claude is writing |
| 2 | History delivery | Full on connect | locked | Simpler, user gets all history immediately |
| 3 | Input method | pty.write() | locked | Handles special chars, escape sequences natively |
| 4 | Client renderer | HTML div (not xterm.js) | locked | Eliminates cursor-sequence bugs entirely |
| 5 | ANSI conversion | Server-side | locked | Phone receives ready-to-display HTML |

## Integration Risks

- **capture-pane performance**: 10 WSL calls/sec per session. With 3 sessions = 30 calls/sec.
  Mitigation: only poll sessions with active clients. Stop polling if no clients connected.
- **ANSI-to-HTML fidelity**: 256-color and true-color support may need iteration.
  Mitigation: start with 16-color, extend if needed. Claude Code primarily uses basic colors.
- **Large frame on connect**: 500+ lines of HTML could be large.
  Mitigation: chunked delivery (reuse existing chunk pattern), compress with permessage-deflate.

## Affected Files

| File | Action | Change Description |
|------|--------|--------------------|
| `server.js` | modify | Replace proc.onData output stream with capture-pane polling; add ANSI-to-HTML converter; remove scrollback/sync handlers; add frame/full-frame senders |
| `public/index.html` | modify | Remove xterm.js; replace with scrollable monospace div; update message handlers; keep all UI (swipe, scroll zones, tabs, auth, theme) |
| `public/vendor/xterm.min.js` | delete | No longer needed |
| `public/vendor/xterm.min.css` | delete | No longer needed |
| `public/vendor/addon-fit.min.js` | delete | No longer needed |
| `public/vendor/addon-webgl.min.js` | delete | No longer needed |
| `public/vendor/addon-canvas.min.js` | delete | No longer needed |
| `CLAUDE.md` | modify | Update architecture, remove xterm.js gotchas |

## Implementation Sequence

1. **ANSI-to-HTML converter**: Build and test the server-side converter function.
   Pure function, no side effects. Test with sample capture-pane output.
   - Dependencies: none
   - Deliverable: `ansiToHtml(line)` function that converts a single ANSI line to HTML

2. **Server capture loop**: Replace proc.onData output stream with capture-pane
   polling loop. Add frame diffing. Send frame/full-frame messages.
   Keep pty attachment for input (pty.write still works).
   - Dependencies: step 1
   - Deliverable: server sends HTML frames instead of raw pty output

3. **Client HTML renderer**: Remove xterm.js. Build scrollable monospace div with
   ANSI color CSS classes. Handle frame/full-frame messages. Wire up scroll zones
   to div.scrollTop.
   - Dependencies: step 2
   - Deliverable: phone displays pre-rendered terminal output

4. **Full-frame on connect**: On session connect, capture full history
   (capture-pane -S -500), convert to HTML, send as full-frame. Chunked if large.
   - Dependencies: step 2, 3
   - Deliverable: phone loads full history on connect/resume

5. **Cleanup and polish**: Remove xterm vendor files. Update CLAUDE.md.
   Test swipe navigation, scroll zones, theme toggle, attention detection,
   image upload with new renderer.
   - Dependencies: step 3, 4
   - Deliverable: v4.0 release candidate

## Verification Strategy

- [ ] Create session -> Claude Code launches -> phone shows colored output
- [ ] Type message -> appears in tmux -> response renders on phone with colors
- [ ] Scroll up -> full conversation history visible
- [ ] Switch apps -> come back -> history intact (tmux has it)
- [ ] Create second session -> first session stays alive
- [ ] PM2 restart -> sessions recovered -> phone reconnects with full history
- [ ] Quick actions (Clear, Esc, Up, Down) work
- [ ] Swipe between sessions works
- [ ] Theme toggle (light/dark) works
- [ ] Image upload works
- [ ] Attention notifications work
- [ ] Auth (TOTP, passkeys) unchanged
