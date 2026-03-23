---
project: claude-mobile
type: spec
status: draft
created: 2026-03-23
updated: 2026-03-23
source: (conversation-driven -- scrollback reviewer + first principles architect)
---

# Technical Design: Reliable History + dtach Migration

## Overview

Two-phase design. Phase 1 fixes scrollback corruption with chunked client-side
writes. Phase 2 replaces tmux with dtach for process persistence, using the
existing server-side ring buffer (`session.scrollback`, 400KB) for history
replay on reconnect. Server-side history is preserved across all scenarios
(PWA kill, PM2 restart, phone reconnect). E2E crypto stays. Server stays on
Windows.

## Current State

- `server.js` (1676 lines): 11 tmux functions (lines 44-112), scrollback via
  `capture-pane -p -e -J -S -10000` sent as single 102KB WebSocket message
- `session.scrollback` already captures all raw pty output in a 400KB ring
  buffer (lines 901-904) -- used for attention detection, never sent to client
- `public/index.html`: xterm.js receives scrollback via `term.write(data)` in
  one call, causing parser corruption on large payloads
- tmux provides process persistence but adds a terminal emulation layer that
  fights xterm.js (alternate screen, scrollback management, window sizing)
- dtach is NOT installed in WSL Ubuntu-24.04

## Target State

### Phase 1: Reliable Scrollback (on v3.0.2 base, keep tmux)

```
Server: captureTmuxScrollback() -> send as-is (no change)
Client: term.reset() -> write 50 lines at a time using term.write(chunk, callback)
```

Client-only fix: chunked writes with xterm.js callback API. No server changes.

### Phase 2: dtach + Server-Side History Replay

```
Claude Code -> dtach (pty detacher, no terminal emulation)
  -> wsl.exe (pty bridge)
    -> node-pty (server.js)
      -> session.scrollback (400KB ring buffer, already exists)
      -> E2E encrypted WebSocket
        -> xterm.js (phone)
```

dtach replaces tmux for process persistence. No terminal emulation layer.
xterm.js receives raw pty output directly from Claude Code.

On reconnect (phone reconnects, PWA killed, PM2 restart + dtach reattach):
server sends `session.scrollback` contents to client using the same chunked
write path from Phase 1. This replaces `captureTmuxScrollback()`.

The raw scrollback contains all ANSI sequences (including Claude Code TUI
cursor positioning). With `term.reset()` before replay, xterm.js processes
these from scratch, rebuilding the exact display state. This is functionally
equivalent to having been connected the whole time.

### History persistence across failure modes

| Scenario | tmux (current) | dtach + buffer (target) |
|----------|---------------|------------------------|
| Phone reconnects (session alive) | capture-pane | session.scrollback replay |
| PWA killed and reopened | capture-pane | session.scrollback replay |
| PM2 restart (dtach survives) | capture-pane on recovery | session.scrollback rebuilt from live output |
| Server machine reboots | tmux sessions lost | dtach sessions lost |

Both approaches lose history on machine reboot. For all other scenarios,
server-side history is preserved.

## Key Decisions

| # | Decision | Chosen | Status | Rationale |
|---|----------|--------|--------|-----------|
| 1 | History colors | Keep with chunked writes | locked | term.write(chunk, callback) sequences chunks safely |
| 2 | E2E encryption | Keep | locked | Defense in depth over Tailscale WireGuard |
| 3 | Server host | Stay on Windows | locked | Avoid PM2 + Tailscale reconfiguration |
| 4 | Process persistence | dtach (Phase 2) | locked | Minimal pty detacher, no terminal emulation overhead |
| 5 | Server-side history | session.scrollback ring buffer | locked | Already exists (400KB). Replaces capture-pane on reconnect. No history loss on PWA kill. |

## Integration Risks

- **dtach availability**: Not installed in WSL. Needs `apt install dtach`.
  Mitigation: install.sh should check and install. dtach is in Ubuntu repos.
- **dtach vs tmux session naming**: dtach uses socket files, not named sessions.
  Socket path: `/tmp/cm-{id}.dtach`. Different discovery mechanism than
  `tmux list-sessions`.
- **Raw ANSI replay quality**: The scrollback buffer contains raw pty output
  including TUI cursor positioning. With `term.reset()` before chunked replay,
  xterm.js rebuilds the screen from scratch. May include intermediate TUI
  artifacts (progress bars, spinners) but final state will be correct.
  Mitigation: tested in Phase 1 before proceeding.
- **Buffer size on PM2 restart**: When PM2 restarts, `session.scrollback` is
  lost (in-memory). dtach session survives but buffer starts empty. New output
  from the live session rebuilds the buffer. First reconnect after PM2 restart
  will have partial history (only output since restart).
  Mitigation: acceptable -- PM2 restarts are rare and brief.
- **Phase 1 -> Phase 2 transition**: Phase 1 fixes work with tmux. Phase 2
  removes tmux entirely. No backward compatibility needed between phases.

## Affected Files

| File | Phase | Action | Change |
|------|-------|--------|--------|
| `public/index.html` | 1 | modify | Chunked scrollback writes with term.reset() + callback API |
| `server.js` | 2 | modify | Replace 11 tmux functions with dtach equivalents; connect handler sends session.scrollback |
| `install.sh` | 2 | modify | Add `apt install dtach` |
| `CLAUDE.md` | 2 | modify | Update architecture, replace tmux with dtach references |

## Implementation Sequence

1. **Phase 1: Chunked scrollback writes** (client-only)
   - Dependencies: none
   - Change `case 'scrollback'` in index.html:
     - `term.reset()` before writing
     - Split data into 50-line chunks
     - Write each chunk using `term.write(chunk, callback)` -- callback triggers next chunk
     - Last chunk scrolls to bottom
   - Deliverable: scrollback loads without corruption, with colors
   - Verification: connect to session with 1000+ lines, scroll up, history intact and ordered

2. **Phase 2: dtach migration + server-side replay** (server)
   - Dependencies: Phase 1 verified
   - Install dtach in WSL: `apt install dtach`
   - Replace tmux functions in server.js:
     - `createTmuxSession` -> `createDtachSession`: `dtach -n /tmp/cm-{id}.dtach -z bash -c 'cmd.exe /c claude'`
     - `attachToTmux` -> `attachToDtach`: `pty.spawn('wsl.exe', [..., 'dtach', '-a', '/tmp/cm-{id}.dtach'])`
     - `listTmuxSessions` -> `listDtachSessions`: scan `/tmp/cm-*.dtach` socket files
     - `tmuxSessionAlive` -> `dtachSessionAlive`: check if socket file exists + process alive
     - `killTmuxSession` -> `killDtachSession`: kill process + remove socket
     - Remove: `ensureTmuxConfig`, `getTmuxDimensions`, `captureTmuxScrollback`, `getTmuxPanePath`
   - Update connect handler (case 'connect'):
     - Replace `captureTmuxScrollback()` call with `session.scrollback`
     - Send `session.scrollback` as scrollback message (same format, chunked on client)
   - Deliverable: Claude Code runs in dtach, history replays from server buffer on reconnect
   - Verification: create session, chat, kill PWA, reopen -- history restored

## Verification Strategy

- [ ] Phase 1: Connect to session with 1000+ lines -- history loads with colors, correct order
- [ ] Phase 1: Scroll up through full history -- no corruption, no missing lines
- [ ] Phase 2: Create session -- Claude Code launches in dtach
- [ ] Phase 2: Chat with Claude -- responses render correctly
- [ ] Phase 2: Kill PWA, reopen -- history restored from server buffer
- [ ] Phase 2: PM2 restart -- dtach session survives, phone reconnects with new output
- [ ] Phase 2: Multiple sessions -- both stay alive independently
- [ ] Phase 2: Close session -- dtach socket cleaned up
- [ ] Both: Quick actions (Clear, Esc, Up, Down) work
- [ ] Both: Auth, encryption, notifications unchanged
