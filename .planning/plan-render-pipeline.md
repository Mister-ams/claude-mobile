---
project: claude-mobile
type: plan
status: draft
created: 2026-03-23
updated: 2026-03-23
source: .planning/tech-design-v4-thin-viewer.md
---

# Plan: v4.0 Thin Viewer Architecture

## Summary

10 tasks across 4 waves. 4 parallel-eligible. Replaces xterm.js terminal
emulation with server-rendered HTML frames from tmux capture-pane.

## Wave 0 -- Foundation (no dependencies)

### T01: ANSI-to-HTML converter function
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: medium (~60 lines)
**Verification**: `node -e "require('./server.js')"` -- or extract function and
test with sample ANSI input: `\x1b[31mhello\x1b[0m` -> `<span class="c1">hello</span>`

Build `ansiToHtml(line)` function in server.js. Parses SGR sequences
(\x1b[Nm) into CSS class spans. Handles:
- 8 foreground colors (30-37) + 8 bright (90-97) -> classes c0-c7, c8-c15
- 8 background colors (40-47) + 8 bright (100-107) -> classes bg0-bg7, bg8-bg15
- Bold (1), underline (4), italic (3) -> classes b, u, i
- Reset (0) -> close all open spans
- HTML-escape the text content (&, <, >)
- Return HTML string for the line

### T02: ANSI color CSS classes
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small (~30 lines)
**Verification**: grep index.html for `.c0` through `.c15` classes

Add CSS classes matching Palantir theme colors for both dark and light mode:
- `.c0` through `.c15` (foreground colors)
- `.bg0` through `.bg15` (background colors)
- `.b` (bold/bright), `.u` (underline), `.i` (italic)
- Map to existing `--intent-ok`, `--intent-danger`, `--accent`, etc. vars

---

## Wave 1 -- Server rendering pipeline (depends on T01)

### T03: Capture-pane polling loop
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: T01
**Risk**: medium
**Parallel**: no
**Effort**: large (~100 lines)
**Verification**: pm2 logs show "frame sent" audit entries when client connected

Replace `wireSessionProc` output path. Keep proc.onData for scrollback
accumulation + attention detection. Add:
- `session.captureTimer`: setInterval(100ms) when clients.size > 0
- Each tick: `captureTmuxScrollback(name)` with `-S -500`
- Split into lines, compare against `session.lastFrame` (string array)
- Changed lines: convert via `ansiToHtml()`, build changes array
- `secureSend(ws, { type: 'frame', session, changes })` to all clients
- Stop timer when clients.size === 0
- On connect: send `full-frame` with all lines

### T04: Remove v3 output messages from server
**Domain**: api
**Action**: modify
**Files**: `server.js`
**Depends on**: T03
**Risk**: medium
**Parallel**: no
**Effort**: small (~20 lines removed)
**Verification**: grep server.js for `type: 'output'` -- should not exist

Remove from wireSessionProc.onData:
- `session.outputSeq++` and the output message send loop
- Keep: scrollback accumulation, attention detection, broadcastSessions
Remove from connect handler:
- scrollback-chunk / scrollback-end sending (replaced by full-frame in T03)
Remove: `case 'sync-request'` handler
Remove: `case 'resize'` handler

---

## Wave 2 -- Client renderer (depends on T02, T03)

### T05: Terminal display div + frame handlers
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: T02, T03
**Risk**: high
**Parallel**: no
**Effort**: large (~150 lines)
**Verification**: create session from phone, see colored Claude Code output

Remove xterm.js initialization:
- Remove `<script>` tags for xterm, addon-fit, addon-webgl, addon-canvas
- Remove `<link>` for xterm.min.css
- Remove `makeTerm()`, all `terms{}`, `fits{}`, `lastSeqs{}`, `scrollbackChunks{}`
- Remove `getTermTheme()` (colors now in CSS classes)

Add terminal display:
- Per-session `<div class="term-content" id="tc-{id}">` inside term-area
- Each line is a `<div class="term-line">` with pre-rendered HTML from server
- CSS: `font-family: 'SF Mono', monospace; font-size: 13px; line-height: 1.286;
  white-space: pre; overflow-y: auto; -webkit-overflow-scrolling: touch;`

Add message handlers:
- `case 'full-frame'`: create line divs, set innerHTML, scrollToBottom
- `case 'frame'`: update changed line divs by row index

### T06: Wire scroll zones to div scrollTop
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: T05
**Risk**: low
**Parallel**: no
**Effort**: small (~15 lines)
**Verification**: tap scroll zones on phone, content scrolls up/down

Replace `scrollTerm(lines)`:
- Get the active term-content div
- `div.scrollTop += lines * lineHeight` (lineHeight = 13 * 1.286 = 16.7px)

Replace `scrollBottom()`:
- `div.scrollTop = div.scrollHeight`

### T07: Update switchTo / closeSession for div renderer
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: T05
**Risk**: medium
**Parallel**: yes (with T06)
**Effort**: medium (~40 lines)
**Verification**: create 2 sessions, swipe between them, close one

Update `switchTo(id)`:
- Create term-content div if not exists (instead of Terminal instance)
- Show/hide via CSS class (same pattern as term-wrap active/swipe-visible)
- Send `connect` message (unchanged)

Update `closeSession(id)`:
- Remove term-content div (instead of term.dispose())
- Clean up references

Update `newSession()`:
- Send `create` with cols only (no rows -- tmux manages height)
- Calculate cols from screen width / charW (same formula)

---

## Wave 3 -- Cleanup (depends on T04, T05, T06, T07)

### T08: Remove xterm vendor files
**Domain**: config
**Action**: delete
**Files**: `public/vendor/xterm.min.js`, `public/vendor/xterm.min.css`,
  `public/vendor/addon-fit.min.js`, `public/vendor/addon-webgl.min.js`,
  `public/vendor/addon-canvas.min.js`
**Depends on**: T05
**Risk**: low
**Parallel**: yes
**Effort**: small (delete 5 files)
**Verification**: `ls public/vendor/` -- should be empty or have no xterm files

### T09: Remove v3 message handlers from client
**Domain**: frontend
**Action**: modify
**Files**: `public/index.html`
**Depends on**: T05
**Risk**: low
**Parallel**: yes (with T08)
**Effort**: small (~30 lines removed)
**Verification**: grep index.html for `'output'` case, `'scrollback'` case -- removed

Remove from handle():
- `case 'output'` handler
- `case 'scrollback'` handler
- `case 'scrollback-chunk'` handler
- `case 'scrollback-end'` handler
- `case 'sync'` handler
Remove globals: `userScrolled`, `lastSeqs`, `scrollbackChunks`

### T10: Update CLAUDE.md
**Domain**: config
**Action**: modify
**Files**: `CLAUDE.md`
**Depends on**: T05
**Risk**: low
**Parallel**: yes (with T08, T09)
**Effort**: small
**Verification**: read CLAUDE.md, confirm architecture matches v4

Update:
- Architecture diagram: remove xterm.js, add capture-pane polling
- Key decisions: thin viewer, 100ms polling, ANSI-to-HTML server-side
- Remove xterm.js gotchas (alternate-screen, fit, scrollback)
- Add new gotchas (capture-pane performance, frame diffing)

---

## Dependency Graph

```
Wave 0:  T01 (converter)  T02 (CSS classes)
              |                 |
Wave 1:  T03 (capture loop)    |
              |                 |
         T04 (remove v3 output)|
              |                 |
Wave 2:  T05 (client renderer, depends on T02 + T03)
              |
         T06 (scroll zones)  T07 (switchTo/close)
              |                 |
Wave 3:  T08 (delete vendors) T09 (remove handlers) T10 (docs)
```

## Verification Mapping

| # | Criterion | Verified By | Check |
|---|-----------|-------------|-------|
| V1 | Colored output on phone | T05 | Create session, see Claude Code with colors |
| V2 | Input works | T05 | Type message, response appears |
| V3 | Scroll history | T06 | Scroll up, full conversation visible |
| V4 | Resume after app switch | T03 | Switch apps, come back, history intact |
| V5 | Multiple sessions | T07 | Create 2 sessions, both stay alive |
| V6 | PM2 restart recovery | T03 | pm2 restart, sessions recovered |
| V7 | Quick actions | T05 | Clear, Esc, Up, Down work |
| V8 | Swipe navigation | T07 | Swipe between sessions |
| V9 | Theme toggle | T02 | Toggle light/dark, colors update |
| V10 | Image upload | T05 | Attach image, send message |
| V11 | Attention notifications | T03 | Claude finishes, notification fires |
| V12 | Auth unchanged | -- | TOTP login works (no changes) |
