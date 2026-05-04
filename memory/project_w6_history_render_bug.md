---
name: W6 history-render bug
description: Post-mortem of the grid-mode reconnect bug that forced T24 to be reverted on 2026-05-02. Resolved in 3.2.7 and confirmed via cutover in 3.2.18.
type: project
status: completed
created: 2026-05-02
updated: 2026-05-04
---

# W6 history-render bug -- closed

## Symptom (as reported)

W6's T24 flipped the default renderer to grid (commit 3c1c402, version 3.2.7).
On any client that already had a session open, history/scrollback failed to
render after a WS reconnect. Same client opened with explicit
`?renderer=grid` worked fine. Reverted same day (commit da4b2fc).

## Root cause

`public/index.html:735`. The auth message handler's "reconnect with active
session" branch sent a `connect` message that omitted the `renderer` field:

```js
// pre-fix
if (activeSession !== null) queueSend({ type: 'connect', session: activeSession });
```

Server `case 'connect'` (server.js:1638) reads:

```js
ws.gridRenderer = (msg.renderer === 'grid');
```

`undefined === 'grid'` is false. The WS's `gridRenderer` flag flipped to
false on every reconnect. Server then took the legacy branch
(server.js:1647-1650) and shipped `{ type: 'scrollback', data: ... }` --
which a grid-mode client's handler (index.html:795) drops because it gates
on `terms[m.session]`, an entry that only exists in xterm mode. All
subsequent PTY output went through the same legacy `output` path on that
WS, also dropped by the same gate. Grid client looked frozen.

## Why opt-in masked it

Every other `connect` sender already included `renderer: RENDERER_MODE`:

- `index.html:1120` (switchTo) -- first session attach
- `index.html:1957` (visibilitychange) -- E8 tab-return resync (W5)

Line 735 was missed when W5 added the per-WS grid flag. The post-auth
reconnect path is the only one that fires on a stale WS (token refresh,
network blip, server restart). Opt-in users testing in W5 hit fresh page
loads with `activeSession === null`, so line 735 never ran for them.

The W6 deploy (`pm2 restart`) dropped every connected client's WS at
once. Each came back through the auth path with a populated
`activeSession`, hit line 735, and got hosed.

## Fix

One line, shipped in 3.2.7 (commit dc29012):

```diff
-if (activeSession !== null) queueSend({ type: 'connect', session: activeSession });
+if (activeSession !== null) queueSend({ type: 'connect', session: activeSession, renderer: RENDERER_MODE });
```

## Verification chain

End-to-end proof landed in three layers before the cutover retry:

1. `.planning/spike-w6-connect-probe.js` -- WS-level: bare connect returns
   `scrollback`, renderer-tagged returns `snapshot`. Confirmed the server
   contract asymmetry.
2. `.planning/spike-w6-browser-test.py` + `spike-w6-input-inject.js` --
   Playwright A/B against the same fresh session at iPhone 14 viewport:
   unpatched -> post-reconnect marker NOT visible (frozen); patched ->
   marker visible (live).
3. Audit log on 3.2.7 prod: `[SNAPSHOT] cm-1 viewport=31 scrollback=1045
   seq=290` follows every reconnect. Pre-fix this was `[SCROLLBACK]`.

## Lesson

Defensive coding around connect-message shape: every `connect` sender
must include the renderer field, or it should be added by the WS sender
wrapper rather than at each call site. The four `connect` senders should
either share a builder or the server should treat missing `renderer` as
"keep current" rather than reset to false.

A second-order miss: iOS Safari served stale 3.2.6 HTML on the user's
phone after the deploy despite `Cache-Control: no-cache, no-store,
must-revalidate`. The audit log showed alternating SCROLLBACK
(reconnect, stale HTML) and SNAPSHOT (fresh load, patched HTML) from the
same IP. Forced a full Safari tab close + reopen to bust the cache.

## Related work

- 11 follow-on grid-mode polish patches (3.2.7..3.2.17) shipped before
  the T24 retry, addressing every visible regression discovered during
  soak testing. See `.planning/STATE-render-pipeline.yaml`.
- T24 retry shipped 3.2.18 on 2026-05-04. Cutover successful.
- T26-T28 (delete legacy WS scrollback handler, drop xterm.js vendor,
  sweep CLAUDE.md) explicitly held -- legacy xterm path stays as a
  permanent `?renderer=xterm` fallback rather than being deleted.
