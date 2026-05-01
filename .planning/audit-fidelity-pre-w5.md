---
project: claude-mobile
type: audit
status: completed
created: 2026-05-02
updated: 2026-05-02
source: .planning/plan-render-pipeline.md (T05)
---

# Audit: WS-Path Sequence Fidelity (Pre-W5)

T05 of W2. Establishes a documented baseline that the v3 PTY-to-client byte
path performs zero filtering or rewriting of ANSI sequences before W5
introduces the headless-VT pipeline. The cell-grid renderer in W5+ must
match this fidelity.

ASCII only.

## Method

Walked every site that touches the byte stream from `proc.onData` through
`term.write`. Every `secureSend(...)` call in `server.js` was inspected;
every `term.write(...)` site in `public/index.html` was inspected; the
input-path `proc.write(...)` was checked symmetrically.

## Findings

### Output path (PTY -> client) -- ZERO filtering

| Site | Hop | What it does | Byte-modifying? |
|---|---|---|---|
| `server.js:1013-1014` | PTY chunk -> handler | onData callback receives raw `data` string | no |
| `server.js:1015-1022` | append to scrollback | `session.scrollback += data`; truncates from head when >400 KB. Surrogate-pair-aware: increments `start` by 1 if it lands on a low surrogate (UTF-16 safety, not byte filtering) | no (UTF-16 boundary safety only) |
| `server.js:1018-1031` | T02 coalescer | buffer + flush on 16/4/64; `flushOutput` builds `{type:'output', session, data: combined}` from raw concatenation | no |
| `server.js:323-344` | secureSend | JSON.stringify -> AES-256-GCM. Encryption is content-preserving by design | no |
| WS wire | encrypted JSON envelope | base64url(iv + ciphertext + tag); seq counter | no |
| `public/index.html` (decrypt) | client receives | AES-GCM decrypt, JSON.parse | no |
| `public/index.html:771-777` | T03 batcher | enqueue into `pendingTermWrites` Map; flush via single rAF | no |
| `public/index.html:861-868` | flush -> term.write | one combined `term.write(joinedData)` per session per frame; scroll-preserve hack runs once per frame | no |

The full chain preserves the byte sequence verbatim. Alt-screen
(`\x1b[?1049h`), DECSTBM (`\x1b[<top>;<bot>r`), mouse tracking
(`\x1b[?1000h`/`?1006h`), OSC 8 (`\x1b]8;;url\x1b\\`), and relative
cursor moves (`\x1b[<n>A/B/C/D`) all pass through.

### Input path (client -> PTY) -- ZERO modification

| Site | What it does | Byte-modifying? |
|---|---|---|
| `server.js:1448-1451` | size cap (64 KB), warning if exceeded | no (rejects, doesn't modify) |
| `server.js:1452-1456` | `checkCanary(msg.data)` -- inspects for suspicious patterns, emits warning | no (observability only) |
| `server.js:1457-1458` | sha256 prefix logged for audit trail | no |
| `server.js:1460` | `activeSession.proc.write(msg.data)` | no |

Canary check is read-only. Bytes reach the PTY verbatim.

### Scrollback replay (reconnect) -- safe but worth flagging

`public/index.html:789-808` chunks the server-sent scrollback string by
splitting on `\n`, slicing into 50-line groups, rejoining with `\n`,
and `term.write`-ing each chunk with a callback-paced sequence.

- `split('\n').join('\n')` is byte-exact for the line content.
- Chunk boundaries are at `\n` characters. ANSI escape sequences (CSI,
  OSC, DCS) are never terminated by `\n` -- they end with letters
  (CSI), `\x07` BEL or `\x1b\\` ST (OSC), etc. So no escape sequence
  is split across chunks.
- Callback-paced writes (`term.write(chunk, writeNextChunk)`) ensure
  xterm.js's parser drains each chunk before the next arrives.

**Caveat**: if an OSC 8 hyperlink ever embedded a literal `\n` inside
its URI (it shouldn't, per the spec), the chunker would split it. W4
spike should explicitly probe an OSC 8 link in scrollback to confirm
the round-trip works.

### Resize path -- bounds drift from TDD

| Field | server.js:1469-1470 (current) | tech-design E4 (target) |
|---|---|---|
| cols | clamped to [40, 300] | [10, 400] |
| rows | clamped to [10, 200] | [5, 200] |

Current bounds are tighter than the TDD specifies. Two consequences:
- A small mobile-portrait window with cols<40 is rounded up to 40 -- 
  the CLI sees a wider terminal than the viewport and clips.
- A very tall landscape window with rows>200 caps at 200 -- minor.

**T06 will reconcile**: bring the server clamp in line with the TDD's
[10, 400] cols and [5, 200] rows.

## Conclusion

The v3 byte path is fully transparent. The cell-grid pipeline introduced
in W5 must preserve the same fidelity:

- All ANSI sequences must round-trip through `@xterm/headless` -> diff
  builder -> client renderer.
- OSC 8 link metadata must be readable from the headless buffer API
  (D3 / W4 spike must validate this without monkey-patching).
- Scrollback chunking can be retired in W5 (cell-grid scrollback is
  shipped as `RowChange[]`, not a byte string).
- T06 fixes the resize-bounds drift to match TDD E4.

No additional teardown work is required before W5 starts: the v3 path
filters nothing and the cutover hazard surface is limited to
`@xterm/headless` parity (the W4 spike's job).
