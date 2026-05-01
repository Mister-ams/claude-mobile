---
project: claude-mobile
type: plan
status: archived
created: 2026-03-23
updated: 2026-05-01
source: .planning/audit-v3.1.3-review.md
---

# Plan: v3.1.3 Hardening (19 Must-Fix)

Source: audit-v3.1.3-review.md (dt.review full mode, 4 agents)
Scope: server.js, public/index.html
Tasks: 18 (F2+F4 merged) | Waves: 4 | Parallel-eligible: 16

## Wave 0 -- Foundation (2 tasks, sequential)

Fix first -- all other error handling depends on these.

### T01: Wrap config.json read in try/catch with diagnostic message

**Domain**: api
**Action**: modify
**Files**: server.js (line 17)
**Depends on**: none
**Risk**: low
**Parallel**: no (T02 depends on config loading)
**Effort**: small
**Audit finding**: #10 (score 95)
**Fix**: Wrap `JSON.parse(fs.readFileSync(...))` in try/catch. On ENOENT, print
human-readable message pointing to config.example.json, then `process.exit(1)`.
On SyntaxError, print "config.json is malformed" with the parse error, then exit.
**Verification**: Delete config.json, run `node server.js`, confirm clear error
message (not a raw stack trace). Restore config.json.

### T02: Add stderr fallback to audit() empty catch

**Domain**: api
**Action**: modify
**Files**: server.js (line 404)
**Depends on**: T01
**Risk**: low
**Parallel**: no
**Effort**: small
**Audit finding**: #11 (score 95)
**Fix**: Replace `catch {}` with `catch (e) { process.stderr.write('audit write
failed: ' + e.message + '\n'); }`. Keep `console.log` as primary output.
**Verification**: Set AUDIT_PATH to a read-only location, trigger an auth event,
confirm stderr output appears in PM2 logs.

## Wave 1 -- Startup & File I/O Error Handling (6 tasks, all parallel)

All touch disjoint functions. Fix empty catches to distinguish ENOENT from
corruption, and add audit/stderr logging on failure.

### T03: Fix loadTotpSecret empty catch -- distinguish ENOENT from corruption

**Domain**: api
**Action**: modify
**Files**: server.js (lines 115-119)
**Depends on**: T02
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #13 (score 92)
**Fix**: Catch specifically. If `e.code === 'ENOENT'`, silently return (first run).
Otherwise, `audit('ERROR', ...)` and `process.stderr.write(...)` -- corrupt TOTP
file must be visible, not silently ignored.
**Verification**: Create a malformed .totp-secret file, start server, confirm
audit log entry and stderr output. Remove file, confirm clean startup.

### T04: Fix loadOrCreateIdentityKey empty catch -- log corruption, flag event

**Domain**: api
**Action**: modify
**Files**: server.js (lines 155-159)
**Depends on**: T02
**Risk**: medium (generates new key on corruption -- breaks TOFU for all clients)
**Parallel**: yes
**Effort**: small
**Audit finding**: #14 (score 92)
**Fix**: Distinguish ENOENT (generate silently) from SyntaxError/other (audit
prominently as `'SECURITY'` event: "Identity key file corrupt, generating new
keypair -- clients will see key change warning"). Still generate new key on error
but make it visible.
**Verification**: Write garbage to .server-identity-key, start server, confirm
SECURITY audit entry. Remove file, confirm silent generation.

### T05: Add try/catch to saveCredentials with audit on failure

**Domain**: api
**Action**: modify
**Files**: server.js (line 466)
**Depends on**: T02
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #12 (score 95)
**Fix**: Wrap `fs.writeFileSync` in try/catch. On failure, `audit('ERROR',
'Credential save failed: ' + e.message)`. Return false so callers can optionally
surface it. Current callers (passkey registration, counter update) should log but
not crash.
**Verification**: Set CRED_PATH to read-only location, register a passkey, confirm
audit entry and no crash.

### T06: Fix listDtachSessions empty catch -- distinguish WSL unavailable

**Domain**: api
**Action**: modify
**Files**: server.js (line 55)
**Depends on**: T02
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #18 (score 95)
**Fix**: Replace `catch { return []; }` with `catch (e) { audit('ERROR',
'listDtachSessions failed (WSL may be down): ' + e.message); return []; }`.
Return value stays [] but now the failure is logged.
**Verification**: Stop WSL, call `recoverDtachSessions`, confirm audit entry
includes "WSL" context.

### T07: Fix killDtachSession empty catch -- audit kill failures

**Domain**: api
**Action**: modify
**Files**: server.js (line 96)
**Depends on**: T02
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #19 (score 95)
**Fix**: Replace `catch {}` with `catch (e) { audit('WARN', 'killDtachSession
failed for ' + id + ': ' + e.message); }`.
**Verification**: Attempt to close a non-existent session ID, confirm audit entry.

### T08: Add BER length validation to derToP1363

**Domain**: api
**Action**: modify
**Files**: server.js (lines 178-195)
**Depends on**: none
**Risk**: medium (crypto path -- must not break working signatures)
**Parallel**: yes
**Effort**: small
**Audit finding**: #5 (score 92)
**Fix**: After reading rLen and sLen, add guard: `if (rLen & 0x80 || sLen & 0x80)
throw new Error('multi-byte BER length not supported')`. This fails loudly
instead of silently producing a malformed P1363 signature. Also validate the
outer SEQUENCE tag byte is 0x30.
**Verification**: Existing TOFU connection still works (P-256 integers are always
<=33 bytes, so guard should never fire in normal operation).

## Wave 2 -- Security Fixes (5 tasks, all parallel)

Logic bugs in security-critical functions. No inter-task dependencies.

### T09: Harden secureSend + secureReceive (F2+F4 merged)

**Domain**: api
**Action**: modify
**Files**: server.js (lines 249-307)
**Depends on**: T02
**Risk**: high (encryption layer -- must not break E2E)
**Parallel**: yes
**Effort**: medium
**Audit finding**: #2 (score 95), #4 (score 90)
**Fix -- secureSend (line 249-253)**: Add type filter in the plaintext branch.
Only allow `obj.type === 'key-exchange'` through plaintext. All other message
types when `!ws.encrypted`: queue or drop with `audit('SECURITY', 'Dropped
pre-encryption message: ' + obj.type)`.
**Fix -- secureReceive (line 274)**: After `if (parsed.type === 'key-exchange')`,
add guard: `if (ws.encrypted) { audit('SECURITY', 'key-exchange after encryption
established'); return null; }`. This blocks post-handshake key-exchange injection.
**Fix -- secureReceive (line 279)**: Change `parsed.n <= ws._recvSeq` to
`parsed.n !== ws._recvSeq + 1` for strict sequential enforcement (no gaps).
**Verification**: Connect, complete handshake, send a plaintext `key-exchange`
message -- confirm it is rejected. Send a sequence-gap encrypted message --
confirm rejection.

### T10: Harden validateSessionToken IP check

**Domain**: api
**Action**: modify
**Files**: server.js (lines 331-341)
**Depends on**: none
**Risk**: medium
**Parallel**: yes
**Effort**: small
**Audit finding**: #3 (score 92)
**Fix**: In `issueSessionToken`, replace `req.ip || 'unknown'` with a stricter
getter that logs when IP is unavailable. In `validateSessionToken`, when
`entry.ip === 'unknown'`, still validate but `audit('WARN', 'Token validated
without IP binding')` so the bypass is visible in the audit trail.
**Verification**: Issue token with unknown IP, validate from different IP, confirm
audit WARN entry.

### T11: Sanitize wslDir against shell injection

**Domain**: api
**Action**: modify
**Files**: server.js (lines 63-66)
**Depends on**: none
**Risk**: high (shell injection)
**Parallel**: yes
**Effort**: small
**Audit finding**: #7 (score 87)
**Fix**: Escape single quotes in wslDir before interpolation:
`const safeDir = wslDir.replace(/'/g, "'\\''");` then use `cd '${safeDir}'`.
Alternatively, use `execFileSync('wsl.exe', ['-d', ...])` with argument array
to avoid shell interpolation entirely.
**Verification**: Create a test project dir with a single-quote in the name,
confirm session creates without shell error.

### T12: Fix recordGlobalFailure to filter before length check

**Domain**: api
**Action**: modify
**Files**: server.js (lines 370-371)
**Depends on**: none
**Risk**: medium (rate limiting logic)
**Parallel**: yes
**Effort**: small
**Audit finding**: #8 (score 85)
**Fix**: Before pushing and checking length, filter stale entries:
```
const cutoff = Date.now() - GLOBAL_RATE_WINDOW;
globalFailures = globalFailures.filter(t => t > cutoff);
globalFailures.push(Date.now());
if (globalFailures.length >= GLOBAL_RATE_MAX) { ... }
```
**Verification**: Simulate 20 failures spread across 10 minutes. Confirm only
failures within the 5-minute window trigger lockout, not stale accumulation.

### T13: Guard config.projects[0] against empty array

**Domain**: api
**Action**: modify
**Files**: server.js (lines 1231-1233)
**Depends on**: T01
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #9 (score 85)
**Fix**: Replace `config.projects[0].dir` with
`config.projects?.[0]?.dir || ''`. When dir is empty, the subsequent
`allowedDirs.includes(dir)` check will reject it with a clear error message
("Directory not in allowed project list") instead of a TypeError.
**Verification**: Set config.projects to `[]`, send a create message with no dir,
confirm clean error response (not a crash).

## Wave 3 -- Session Lifecycle & Client (5 tasks, parallel)

PTY management, broadcast safety, WebSocket cleanup, scrollback fix.

### T14: Guard wireSessionProc against reattach handler accumulation

**Domain**: api
**Action**: modify
**Files**: server.js (lines 920-926)
**Depends on**: T09 (broadcastAll called from wireSessionProc path)
**Risk**: medium
**Parallel**: yes
**Effort**: medium
**Audit finding**: #1 (score 95)
**Fix**: Add a generation counter to each session. In `wireSessionProc`, capture
`const gen = ++session.generation` at the top. In onData/onExit callbacks, check
`if (session.generation !== gen) return` to ignore stale handlers. Initialize
`session.generation = 0` in `createSession`.
**Verification**: Simulate rapid dtach detach/reattach (kill the dtach process
twice in quick succession). Confirm scrollback does not double-write and
broadcastAll fires once per event.

### T15: Fix scrollback chunked writer extra newline

**Domain**: frontend
**Action**: modify
**Files**: public/index.html (line 1272)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #6 (score 88)
**Fix**: Change `term.write(chunk + '\n', writeNextChunk)` to
`term.write(chunk + '\n', writeNextChunk)` -- actually the fix is to remove the
trailing `\n` only on the LAST chunk: `const nl = (i < lines.length) ? '\n' : '';
term.write(chunk + nl, writeNextChunk);`. The join already produces newlines
between lines within each chunk; the appended `\n` is only needed as a separator
between chunks, not after the final one.
**Verification**: Reconnect to a session with >100 lines of output. Confirm no
blank lines injected every 50 lines in the replayed history.

### T16: Add error handling to proc.write Claude launch

**Domain**: api
**Action**: modify
**Files**: server.js (lines 969-971)
**Depends on**: T02
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #15 (score 92)
**Fix**: Replace empty catch with `catch (e) { audit('ERROR', 'Claude launch
write failed for session ' + id + ': ' + e.message); }`. Optionally broadcast
an error message to clients subscribed to that session.
**Verification**: Mock a write failure (close the pty before the 500ms timer),
confirm audit entry.

### T17: Add per-client try/catch in broadcastAll

**Domain**: api
**Action**: modify
**Files**: server.js (lines 862-865)
**Depends on**: T09 (secureSend fix)
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #16 (score 88)
**Fix**: Wrap `secureSend` call in try/catch per client:
```
for (const client of allClients) {
  if (client.authenticated && client.readyState === 1) {
    try { secureSend(client, obj); } catch (e) {
      audit('WARN', 'broadcastAll send failed: ' + e.message, client._ip);
    }
  }
}
```
**Verification**: Confirm that a forcibly-closed client does not prevent other
clients from receiving broadcast messages.

### T18: Clear encryptionTimeout in WebSocket close handler

**Domain**: api
**Action**: modify
**Files**: server.js (lines 1326-1332)
**Depends on**: none
**Risk**: low
**Parallel**: yes
**Effort**: small
**Audit finding**: #17 (score 88)
**Fix**: Store `encryptionTimeout` on the ws object (`ws._encryptionTimeout`)
instead of a local const. In the close handler, add
`clearTimeout(ws._encryptionTimeout)` before the existing cleanup.
**Verification**: Connect and immediately disconnect. Confirm no "Encryption
timeout" audit entry fires 10 seconds later.

## Verification Mapping

| # | Audit Finding | Verified By | Check Type |
|---|---------------|-------------|------------|
| V01 | #10 config crash | T01 | manual (delete config.json, run server) |
| V02 | #11 audit() catch | T02 | manual (read-only audit path) |
| V03 | #13 TOTP load | T03 | manual (malformed .totp-secret) |
| V04 | #14 identity key | T04 | manual (malformed .server-identity-key) |
| V05 | #12 saveCredentials | T05 | manual (read-only cred path) |
| V06 | #18 listDtachSessions | T06 | manual (stop WSL) |
| V07 | #19 killDtachSession | T07 | manual (close non-existent session) |
| V08 | #5 derToP1363 | T08 | auto (existing TOFU connection works) |
| V09 | #2+#4 crypto layer | T09 | manual (send post-handshake key-exchange) |
| V10 | #3 token IP bypass | T10 | manual (check audit for WARN on unknown IP) |
| V11 | #7 shell injection | T11 | manual (project dir with single-quote) |
| V12 | #8 global rate | T12 | manual (simulate stale + fresh failures) |
| V13 | #9 empty projects | T13 | manual (empty config.projects array) |
| V14 | #1 reattach leak | T14 | manual (rapid dtach kill x2) |
| V15 | #6 scrollback \n | T15 | manual (reconnect, check for blank lines) |
| V16 | #15 proc.write | T16 | manual (check audit on write failure) |
| V17 | #16 broadcastAll | T17 | manual (force-close one client mid-broadcast) |
| V18 | #17 encryptionTimeout | T18 | manual (connect + immediate disconnect) |

## Risk Summary

- **High risk** (2): T09 (encryption layer), T11 (shell injection fix)
- **Medium risk** (4): T04, T08, T10, T12, T14
- **Low risk** (12): all others

## Execution Notes

- All tasks modify existing code only (no new files)
- server.js receives 17 of 18 fixes; index.html receives 1 (T15)
- Wave 1 tasks are structurally identical (replace empty catch with ENOENT
  check + audit logging) -- batch execution is efficient
- T09 is the highest-risk task; review carefully before committing
