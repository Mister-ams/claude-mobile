---
project: claude-mobile
type: plan
status: draft
created: 2026-03-23
updated: 2026-03-23
source: .planning/tech-design-scrollback-and-dtach.md
---

# Plan: Reliable History + dtach Migration

## Summary

7 tasks across 3 waves. Phase 1 (Wave 0) fixes scrollback corruption
client-side. Phase 2 (Waves 1-2) replaces tmux with dtach and wires
server-side buffer replay for history on reconnect.

## Wave 0 -- Phase 1: Reliable Scrollback (no dependencies)

### T01: Chunked scrollback writes with callback API
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: none
**Risk**: medium
**Parallel**: no
**Effort**: medium (~40 lines)
**Verification**: connect to session with history, scroll up, lines in correct order with colors

Replace the `case 'scrollback'` handler. Current code writes up to 102KB in one
`term.write()` call. New code:
1. `term.reset()` -- clear parser state and existing content
2. Split `m.data` into lines, group into 50-line chunks
3. Write each chunk using `term.write(chunk, callback)` -- callback triggers next chunk
4. After last chunk: `term.scrollToBottom()`
5. Keep the `clientLog` diagnostic calls

---

## Wave 1 -- Phase 2a: dtach Infrastructure (depends on T01 verified)

### T02: Install dtach in WSL
**Domain**: infrastructure
**Action**: modify
**Files**: `install.sh`
**Depends on**: T01
**Risk**: low
**Parallel**: yes
**Effort**: small (~5 lines)
**Verification**: `wsl -d Ubuntu-24.04 -u root -- which dtach` returns a path

Add `apt-get install -y dtach` to install.sh WSL setup section.
Run the install command immediately to make dtach available.

### T03: Replace tmux functions with dtach equivalents
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: T02
**Risk**: high
**Parallel**: no
**Effort**: large (~150 lines changed)
**Verification**: `node -c server.js` passes; create session from phone, Claude launches

Replace these functions:
- `createTmuxSession` -> `createDtachSession`: spawn dtach with socket at `/tmp/cm-{id}.dtach`
- `attachToTmux` -> `attachToDtach`: pty.spawn wsl.exe with `dtach -a /tmp/cm-{id}.dtach`
- `listTmuxSessions` -> `listDtachSessions`: scan `/tmp/cm-*.dtach` socket files
- `tmuxSessionAlive` -> `dtachSessionAlive`: check socket file exists + process alive
- `killTmuxSession` -> `killDtachSession`: kill process + remove socket
- `tmuxName(id)` -> `dtachSocket(id)`: returns `/tmp/cm-{id}.dtach`

Remove these functions (no dtach equivalent needed):
- `ensureTmuxConfig` -- dtach has no config
- `getTmuxDimensions` -- not needed (pty dimensions set at attach)
- `captureTmuxScrollback` -- replaced by session.scrollback buffer
- `getTmuxPanePath` -- not needed (session dir stored in metadata)

### T04: Update connect handler -- send session.scrollback on reconnect
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: T03
**Risk**: medium
**Parallel**: no
**Effort**: small (~15 lines changed)
**Verification**: kill PWA, reopen, history restored from server buffer

Replace in `case 'connect'`:
- Remove the `captureTmuxScrollback()` call
- Send `session.scrollback` as the scrollback message instead:
  ```js
  if (targetSession.scrollback) {
    secureSend(ws, { type: 'scrollback', session: targetSession.id, data: targetSession.scrollback });
  }
  ```
- Keep audit logging with byte count

The client's chunked writer (T01) handles the replay. `session.scrollback`
contains raw pty output (ANSI + content). `term.reset()` ensures clean replay.

### T05: Update session recovery for dtach
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: T03
**Risk**: medium
**Parallel**: yes (with T04)
**Effort**: medium (~40 lines)
**Verification**: `pm2 restart claude-mobile`, sessions recover, phone reconnects

Replace `recoverTmuxSessions` with `recoverDtachSessions`:
- Scan `/tmp/cm-*.dtach` for existing socket files
- For each: check process alive, load metadata, reattach via `attachToDtach`
- Initialize `scrollback: ''` (buffer rebuilds from live output after reattach)
- Remove `ensureTmuxConfig()` call from startup

---

## Wave 2 -- Phase 2b: Cleanup (depends on T03, T04, T05)

### T06: Remove diagnostic logging
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`, `server.js`
**Depends on**: T04
**Risk**: low
**Parallel**: yes
**Effort**: small (~15 lines removed)
**Verification**: grep for `clientLog\|SCROLLBACK\|client-log` -- reduced to essentials

Remove the diagnostic `clientLog` calls and `case 'client-log'` handler
added for troubleshooting. Keep the `clientLog` function for future use.

### T07: Update CLAUDE.md
**Domain**: config
**Action**: modify
**Files**: `CLAUDE.md`
**Depends on**: T03
**Risk**: low
**Parallel**: yes (with T06)
**Effort**: small
**Verification**: read CLAUDE.md, architecture matches dtach

Update:
- Architecture diagram: dtach replaces tmux
- Key decisions: dtach for persistence, server-side buffer for history replay
- Remove tmux gotchas, add dtach gotchas (socket files, buffer rebuild after PM2 restart)
- Remove alternate-screen and capture-pane references
- Add: session.scrollback is the history source (400KB ring buffer)

---

## Dependency Graph

```
Wave 0:  T01 (chunked scrollback)
              |
Wave 1:  T02 (install dtach)
              |
         T03 (replace tmux functions)
              |
         T04 (buffer replay on connect)  T05 (recovery)
              |                             |
Wave 2:  T06 (remove diagnostics)     T07 (docs)
```

## Verification Mapping

| # | Criterion | Verified By | Check |
|---|-----------|-------------|-------|
| V1 | History loads with colors, correct order | T01 | Connect, scroll up, verify |
| V2 | No corruption on scroll | T01 | Scroll full history |
| V3 | Claude launches in dtach | T03 | Create session from phone |
| V4 | Responses render correctly | T03 | Chat with Claude |
| V5 | History restored after PWA kill | T04 | Kill PWA, reopen, scroll up |
| V6 | PM2 restart recovery | T05 | pm2 restart, reconnect |
| V7 | Multiple sessions | T03 | Create 2 sessions |
| V8 | Session close cleanup | T03 | Close session, check socket gone |
| V9 | Quick actions work | T03 | Clear, Esc, Up, Down |
| V10 | Auth/crypto unchanged | -- | TOTP login (no changes) |
