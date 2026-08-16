---
project: claude-mobile
type: spike-report
status: complete
created: 2026-08-16
updated: 2026-08-16
source: .planning/plan-otg-revival.md (Wave 1 / S1)
gates: Wave 5 (herdr backbone, 4.0.0), decisions D1 + D2
---

# Spike report: herdr as the claude-mobile session backbone

Timeboxed feasibility probe of **herdr v0.8.0** (github.com/herdrdev/herdr,
Apache-2.0) as a replacement for the current dtach-in-WSL backbone
(`server.js:42-157`) and the 12-regex attention heuristic
(`server.js:912-983`).

**Overall verdict: NO-GO for Wave 5 as scoped.** Two of the three headline
benefits do not survive contact with the API. Detail in
[Recommendation](#recommendation).

Every claim below is backed by a command and its actual output. Probe
scripts are committed alongside this report as `.planning/spike-herdr-*`.

---

## Environment and install

herdr **is installed** in WSL Ubuntu-24.04, pinned at v0.8.0.

The published installer (`curl -fsSL https://herdr.dev/install.sh | sh`)
always resolves `https://herdr.dev/latest.json`, which has no version
argument -- it cannot pin. The pinned binary was fetched directly from the
GitHub release instead (`spike-herdr-setup.sh`):

```
$ curl -fsSL -o ~/.local/bin/herdr \
    https://github.com/herdrdev/herdr/releases/download/v0.8.0/herdr-linux-x86_64
$ ~/.local/bin/herdr --version
herdr 0.8.0
$ sha256sum ~/.local/bin/herdr
b872ea7e40fa2cb17e857ac9b62b1bf26db7b403c622f5d2f3f5b35f6e9acd28
```

> **PATH note.** The binary lives at `/root/.local/bin/herdr`, which is not
> on the PATH of a non-interactive `wsl -- bash -lc` shell. `command -v herdr`
> returns empty even though herdr is installed and running. Always use the
> absolute path from Node/`server.js`.

Config written to `/root/.config/herdr/config.toml`:

```toml
[session]
resume_agents_on_restore = true
[experimental]
pane_history = true          # OFF by default (secret-safety); needed for scrollback replay
[update]
version_check = false
manifest_check = false
```

`herdr config check` -> `config: ok`.

### The server does not survive its launching WSL session

First launch used `nohup ... &`; `herdr status` reported the server running,
then it was gone seconds later:

```
$ herdr api snapshot
{"id":"cli:api:snapshot","error":{"code":"server_not_running",
 "message":"no herdr server is running at /root/.config/herdr/herdr.sock; ..."}}
```

`setsid nohup herdr server </dev/null &` survives. This is a direct input to
**T08** (the systemd unit): herdr needs a real supervisor, exactly like dtach.

---

## Socket, permissions, and the Windows problem

```
$ stat -c "%n mode=%A (%a) owner=%U:%G" /root/.config/herdr/herdr.sock /root/.config/herdr /root
/root/.config/herdr/herdr.sock  mode=srw------- (600)  owner=root:root
/root/.config/herdr             mode=drwxr-xr-x (755)  owner=root:root
/root                           mode=drwx------ (700)  owner=root:root
```

Confirmed: **no authentication**, filesystem permissions only -- `0600`,
owned by root, inside a `0700` home. Any process running as root inside WSL
can drive the full API. Acceptable given our Node server would be the only
client, but note it is a *local privilege* boundary, not a user boundary.

### Wire protocol

Newline-delimited JSON. Two behaviours the plan's T27 sketch does not
anticipate, both established by raw socket probe:

1. **`params` is mandatory**, even for no-arg methods:
   ```
   [send] {"id":"t1","method":"ping"}
   [recv] {"id":"","error":{"code":"invalid_request",
           "message":"invalid request: missing field `params` at line 1 column 27"}}
   [closed]
   ```
2. **One request per connection.** The server writes the response and closes
   immediately:
   ```
   [send] {"id":"a","method":"ping","params":{}}
   [recv] {"id":"a","result":{"type":"pong","version":"0.8.0","protocol":19,...}}
   [closed]
   [send] {"id":"b",...}   <- never answered
   ```
   Every RPC needs a fresh `connect()`. Long-lived connections exist only for
   `events.subscribe` / `events.wait`.

Protocol version is **19**, schema_version 1, 90 methods.

### There is no Windows build at the pinned version

```
$ curl -fsSL https://herdr.dev/latest.json | python3 -c "...print(list(d['assets'].keys()))"
version: 0.8.0  protocol: 19
asset targets: ['linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64']
```

The v0.8.0 GitHub release carries the same four assets. Windows exists only
on the **preview** channel (v0.8.0 changelog: *"Windows preview downloads now
include Herdr and a modern app-local ConPTY runtime in one archive"*).

This is structural. `claude-mobile`'s Node server runs on **Windows** and
shells into WSL via `wsl.exe`. A Windows process cannot connect to an
`AF_UNIX` socket living in the WSL2 VM's ext4. So T27's premise -- "named
pipe (Windows) / unix socket" -- is **not available at the pinned version**.
Options are (a) move the Node server inside WSL, (b) run a TCP bridge in WSL,
or (c) take herdr off the stable pin onto the Windows preview channel. All
three are larger than "swap the dtach layer".

---

## Question 1 -- Stream fidelity

**Verdict: herdr's pane grid CANNOT replace our server-side mirror. The
~700 LOC retirement is off the table, and the ~500 LOC path costs us OSC-8
hyperlinks permanently.**

### What the API actually returns

`pane.read` returns a **single flat string**. There is no cell grid, no
styled runs, no per-cell attributes:

```
PaneReadResult = { pane_id, workspace_id, tab_id, source, format,
                   text: string, revision: uint64, truncated: bool }
ReadFormat = "text" | "ansi"
ReadSource = "visible" | "recent" | "recent_unwrapped" | "detection"
```

A whole-schema search for structured style data (`spike-herdr-schema.js grid`)
finds nothing:

```
hyperlink  hits=0
osc8       hits=0
url_id     hits=0
cell       hits=3   (all popup sizing / graphics placement)
grid       hits=2   ("grid_cols","grid_rows" -- pane.graphics image placement only)
sgr        hits=0
fg/bg/bold/italic/reverse/underline/style/attr/color   hits=0
```

### Fidelity matrix (16 combinations, live)

A pane was painted with bold / italic / underline / reverse / 24-bit fg /
256-colour bg / an OSC-8 hyperlink, then read back through every
`source x format x strip_ansi` combination. The **output** line was
inspected, deliberately excluding the shell's echo of the command (which
would have read as a false positive).

```
source            format strip  found  SGR  bold ital undl rev  tc   bg256 OSC8 url
visible           text   true   YES    no   no   no   no   no   no   no    no   no
visible           text   false  YES    no   no   no   no   no   no   no    no   no
visible           ansi   true   YES    YES  YES  YES  YES  YES  YES  YES   no   no
visible           ansi   false  YES    YES  YES  YES  YES  YES  YES  YES   no   no
recent            ansi   true   YES    YES  YES  YES  YES  YES  YES  YES   no   no
recent            ansi   false  YES    YES  YES  YES  YES  YES  YES  YES   no   no
recent_unwrapped  ansi   true   YES    YES  YES  YES  YES  YES  YES  YES   no   no
recent_unwrapped  ansi   false  YES    YES  YES  YES  YES  YES  YES  YES   no   no
detection         ansi   *      YES    no   no   no   no   no   no   no    no   no
```

Canonical sample (`visible` / `ansi` / `strip_ansi=false`):

```
"\u001b[0m\u001b[1mBOLD\u001b[0m|\u001b[0m\u001b[3mITALIC\u001b[0m|\u001b[0m\u001b[4mUNDER\u001b[0m|
 \u001b[0m\u001b[7mREVERSE\u001b[0m|\u001b[0m\u001b[38;2;255;100;0mTRUECOLOR\u001b[0m|
 \u001b[0m\u001b[48;5;27mBG256\u001b[0m|LINKTEXT"
```

Three things follow:

1. **SGR survives completely** with `format: "ansi"` -- bold, italic,
   underline, reverse, truecolor, 256-colour background.
2. **OSC-8 is destroyed.** The emitted sequence was
   `ESC]8;id=probe1;https://example.com/spike ESC\ LINKTEXT ESC]8;; ESC\`.
   herdr's emulator *parsed* it (LINKTEXT renders as text, the escape is not
   echoed) and then **dropped the URL on serialization**. `example.com`
   appears nowhere in any of the 16 reads. There is no second channel that
   carries it.
3. **herdr is re-serializing from its own cell grid, not replaying pty
   bytes.** The give-away is the normalized `ESC[0m` reset emitted before
   every attribute run -- that is a renderer's output, not the original
   stream. So herdr *has* a grid internally; it simply does not expose it.

`strip_ansi` is a no-op when `format: "ansi"` (identical results), which is
worth knowing before someone tries to use it as an escape hatch.

### There is no push stream of output

Only three subscribable event kinds exist:

```
$ node spike-herdr-subscription.js
events.subscribe -- Subscription types (27):
  ... pane.output_matched  [lines,match,pane_id,source,strip_ansi]
      pane.agent_status_changed  [agent_status,pane_id]
      pane.scroll_changed  [pane_id]
```

`pane.output_matched` is **pattern-triggered**, not a firehose -- it requires
an `OutputMatch`. The only change-notification primitive is on `events.wait`:

```
events.wait -- EventMatch types (19):
  ... pane_output_changed  [min_revision,pane_id]
```

So the only way to stream a pane is a **long-poll loop**: `events.wait
{pane_output_changed, min_revision}` -> `pane.read` -> repeat. Each read
returns a **full screen snapshot**, not a delta, and every call is a fresh
socket connection (one-request-per-connection, above). Compared with today's
`node-pty` `onData` byte stream that is a materially worse fit for a live
terminal mirror.

### What this means for T31

| Hoped-for outcome | Reality |
|---|---|
| herdr grid drives the client directly; retire `server.js:1016-1198` (206 LOC) **and** the `_extendedAttrs[x]._urlId` reach at `:1099` (~700 LOC total) | **Not possible.** No cell/style data is exposed at all. |
| Feed our existing headless mirror from herdr instead of a pty (~500 LOC) | Possible, but it means **double terminal emulation** (herdr's emulator -> ANSI text -> our xterm mirror -> grid), driven by full-screen polling, and **OSC-8 links are gone before we ever see them**. |

The OSC-8 loss is not recoverable by clever client work: the URL never
crosses the socket. Adopting herdr means deleting the hyperlink feature,
which is precisely what the private-internals hack at `:1099` was written to
preserve. **T31 should be marked not-achievable.**

---

## Question 2 -- Agent state under both launch modes (decides D2)

**Verdict: the stated hypothesis is FALSIFIED -- interop does not defeat
detection. But a different, more serious interop problem was found, and
agent-state accuracy turns out to depend on a remote file that the version
pin does not cover.**

### Both launch modes are detected

**(a) Native WSL `claude`** -- detected immediately:

```
[launch t+0s] agent="claude" status=idle title="root@AMSLaptop14: /tmp/herdr-spike"

pane.process_info -> foreground_processes: [{ pid: 128282, name: "claude", argv: ["claude"] }]
```

**(b) Windows interop `cmd.exe /c claude`** -- also detected, one second later:

```
[launch t+0s] agent=undefined status=unknown
[launch t+1s] agent="claude" status=idle title="claude"

pane.process_info -> foreground_processes: [{ pid: 128817, name: "cmd.exe",
  argv: ["/init","/mnt/c/Windows/system32/cmd.exe","cmd.exe","/c","claude"] }]
```

herdr matches on argv and on the OSC title, not solely on the foreground
process name, so the interop wrapper does not hide the agent.

### Interop finding that DOES matter: cwd divergence

Launching interop from a WSL-only directory silently put Claude somewhere
else entirely:

```
 Accessing workspace:
 C:\Windows
```

`cmd.exe` cannot map `/tmp/herdr-spike` to a Windows path, so it falls back
to `C:\Windows`. The herdr pane's `cwd` and the agent's actual working
directory diverge with no error. Re-running from a `/mnt/c/...` path (which
is what `winPathToWsl` at `server.js:1319` always produces) behaves
correctly, so today's code is safe -- but the failure is silent, and any
future non-`/mnt/c` project dir would hit it.

### Agent state accuracy depends on a REMOTE manifest, not on the pin

This is the most operationally important finding of the spike.

With the manifest **bundled inside the pinned v0.8.0 binary**
(`claude 2026.07.13.1`), a genuine 17-second Claude task was reported as
`idle` for its entire duration -- 367 samples at 200 ms, zero transitions:

```
samples=367  distinct transitions=1
statuses observed: ["idle"]
```

`agent.explain` gives the exact cause:

```
rule=osc_title_working  state=working matched=false prio=1100 region=osc_title
    patterns: ["^[\\x{2800}-\\x{28FF}] "]        <- expects a BRAILLE spinner
    saw: "✳ Calculate 17 times 23"               <- Claude Code 2.1.78 emits U+2733
rule=osc_title_idle     state=idle    matched=true  prio=250
    patterns: ["^\\x{2733} "]                    <- so ✳ is classified IDLE
rule=live_prompt_box    state=idle    matched=true  prio=950 region=prompt_box_body
    patterns: ["^\\s*❯"]
matched_rule = {"id":"live_prompt_box","priority":950,"state":"idle"}
```

A working Claude was classified idle because the shipped manifest predates
this Claude Code build. After fetching the current manifest:

```
$ herdr server update-agent-manifests
  claude    remote    active 2026.08.13.1   remote 2026.08.13.1   updated
```

the same interop pane reports correctly (spinner is now `◐`/`◑`):

```
t+0.10s  status=working agent=claude title="◐ Calculate 17 times 23"
  ... 33 transitions ...
t+28.64s status=idle    agent=claude title="Calculate 17 times 23"
samples=344  statuses observed: ["working","idle"]
```

**Implication:** pinning the binary at v0.8.0 does **not** pin agent-state
behaviour. Detection quality is governed by a TOML manifest fetched from
herdr.dev at runtime, and the copy shipped inside the pinned binary was
already stale enough to report a busy agent as idle indefinitely. Replacing
our 12 local regexes (T29) with this trades a heuristic we control for a
remote file we do not, on a release cadence we do not set. That is a real
downgrade in a notification path, not an obvious upgrade.

### States observed

| State | Observed | Evidence |
|---|---|---|
| `idle` | yes | steady state between prompts |
| `working` | yes (current manifest only) | 33 transitions over a 28 s task |
| `blocked` | **yes** | real permission prompt, below |
| `done` | **never observed** | not seen in any run |

`blocked` fires correctly on a genuine permission prompt -- this is the
trigger T29 actually wants:

```
 Bash command / sudo systemctl restart nginx
 This command requires approval
 Do you want to proceed?
 ❯ 1. Yes ...  Esc to cancel

rule=generic_permission_prompt state=blocked matched=true prio=840
matched_rule = {"id":"generic_permission_prompt",...,"state":"blocked"}
visible_blocker = true
```

State detection was not uniformly reliable even on the current manifest: a
separate 7-second task reported `idle` throughout. Treat `working` as
best-effort; `blocked` looked solid in every trial.

### The decisive D2 finding: the integration cannot work under interop

Reliable state *and* restart-resume both depend on herdr's official agent
integration, which installs a Claude Code hook:

```
$ herdr integration install claude
installed claude integration hook to /root/.claude/hooks/herdr-agent-state.sh
ensured claude settings at /root/.claude/settings.json
```

The hook self-disables unless herdr's environment reaches the agent process:

```sh
[ "${HERDR_ENV:-}" = "1" ]        || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ]   || exit 0
[ -n "${HERDR_PANE_ID:-}" ]       || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
```

herdr does inject those into its panes:

```
$ env | grep -i herdr | sort
HERDR_ENV=1
HERDR_PANE_ID=w7:p1
HERDR_SOCKET_PATH=/root/.config/herdr/herdr.sock
HERDR_TAB_ID=w7:t1
HERDR_WORKSPACE_ID=w7
$ echo WSLENV=$WSLENV
WSLENV=
```

**`WSLENV` is empty**, so none of those variables cross the WSL -> Windows
interop boundary into a `cmd.exe` child. On top of that, the hook is
registered in WSL's `/root/.claude/settings.json`, whereas an interop Claude
reads `C:\Users\MRAL-\.claude\`, and the hook is a `/bin/sh` script needing
`python3` and a unix socket path -- all meaningless on the Windows side.

**Conclusion for D2: the herdr Claude integration is structurally
incompatible with the `cmd.exe /c claude` launch mode.** Anything that
depends on it -- session refs, restart resume, hook-reported (rather than
screen-scraped) state -- requires launching Claude **natively inside WSL**,
which in turn requires authenticating Claude Code inside WSL. That is a
change to the product's auth story, not a backend swap.

---

## Question 3 -- Restart restore

**Verdict: pane shape restores perfectly. The conversation does not. The
headline benefit over dtach is unproven and, under the current launch mode,
unreachable.**

Full run in `spike-herdr-q3-restart.sh` / `q3.log`, with
`resume_agents_on_restore = true` and `pane_history = true` in force.

### What persists on disk

`/root/.config/herdr/session.json` (version 3) holds workspace id, custom
name, `identity_cwd`, tab/pane layout and per-pane `cwd` -- and nothing else:

```
version: 3
workspace count: 7
  occurrences of 'agent':      0
  occurrences of 'session_id': 0
  occurrences of 'session_ref':0
  occurrences of 'resume':     0
  occurrences of 'command':    0
  occurrences of 'argv':       0
```

### Before / after `herdr server stop` + restart

```
BEFORE
 workspaces: w1..w7
 agents: [('w4:p1','claude','idle'), ('w5:p1','claude','blocked'), ('w6:p1','claude','idle')]
 w6:p1 foreground: cmd.exe /c claude   (a real conversation: notes.md, primes, 2 shell cmds)

AFTER
 workspaces: w1..w7
 agents: []
 w6:p1 foreground: { pid: 135373, name: "bash", argv: ["/bin/bash"] }

DIFF SUMMARY
 workspaces before: 7  after: 7  identical ids: True
 panes      before: 7  after: 7  identical ids: True
 cwd preserved for all shared panes: True
 agents before: {'w4:p1':'claude','w5:p1':'claude','w6:p1':'claude'}
 agents after:  {}
```

- **Pane shape: RESTORED.** Workspace/tab/pane ids, labels, layout and cwd
  all came back identically. This is genuinely better than our
  `.session-meta.json` bookkeeping.
- **Scrollback: restored but mangled.** With `pane_history = true` the prior
  screen text replays, but a full-screen TUI re-wrapped into a fresh
  terminal is visually corrupt (`─────────❯`, broken line wrapping). It is a
  text replay, not a grid restore -- useful for a shell, not for Claude's TUI.
- **Agent: NOT resumed.** Every pane came back as a plain `/bin/bash` in the
  right directory. Claude was not relaunched, let alone `--resume`d.

`resume_agents_on_restore` is documented as *"Requires official integrations
that report session refs."* No session ref was ever reported: the interop
pane cannot report one (Question 2), and the native pane never started a
real session because Claude is unauthenticated inside WSL.

> **Explicitly unanswered.** Whether `resume_agents_on_restore` genuinely
> re-attaches a Claude *conversation* could **not** be verified in this
> spike. Doing so requires an authenticated Claude Code **inside WSL**
> (native launch + the integration hook). I did not copy credentials into
> WSL -- that is a secret-handling action for the operator, not an agent.
> What *is* proven is that under today's interop launch mode the answer is
> definitively **no**: restore yields a fresh shell.

---

## Question 4 -- Input atomicity

**Verdict: SOLVED -- herdr provides a genuinely atomic text+submit call.
This is the spike's clearest win.**

`CLAUDE.md:93` records that text and Enter must be a single atomic pty write.
herdr offers a primitive that satisfies this in one socket round-trip.

| # | Method | Round-trips | Submits? | Notes |
|---|---|---|---|---|
| A | `pane.send_text` + `"\n"` (LF) | 1 | **NO** in Claude's TUI | typed into the box, never submitted; *does* submit in a bash shell |
| B | `pane.send_text` + `"\r"` (CR) | 1 | **YES** | atomic |
| C | `pane.send_input {text, keys:["enter"]}` | 1 | **YES** | atomic; **recommended** |
| E | `send_text` then `send_keys` | 2 | yes | the racy baseline -- avoid |

Method A, showing text parked unsubmitted in the prompt box:

```
sent text: "What is 17 times 23? Reply with just the number.\n"
--- screen ---
❯ What is 17 times 23? Reply with just the number.     <- sits in the input box
```

The cause is that `pane.send_text` delivers LF, and a TUI in raw mode needs
CR. A line-disciplined shell accepts LF, which is why Question 1's `printf`
worked and this did not.

Method C with a 229-character payload, delivered intact and unbroken in a
single call:

```
=== method C on w6:p1 ===
payload length=229
OK  socket round-trips=1  elapsed=103ms
--- screen ---
❯ ATOMICITY_PROBE
  xxxxxxxxxxxx... (200 chars, unbroken)
  END_OF_PROBE
✻ Architecting…                      <- submitted and running
```

`pane.send_input` accepts `text` **and** `keys` in one request
(`PaneSendInputParams { pane_id, text?, keys? }`), which is exactly the
atomic primitive the current architecture lacks. `agent.prompt {target, text,
wait}` exists as an agent-level equivalent with an optional wait-until-state.

### Key-name fidelity is imperfect

`pane.send_keys {keys:["shift+tab"]}` returned success but **did not reach
Claude** -- the permission mode never changed. Sending the raw sequence
`ESC[Z` via `pane.send_text` worked immediately (`⏸ manual mode on`). Prefer
raw escape sequences over herdr key names for anything beyond `enter`.

---

## Recommendation

### GO / NO-GO: **NO-GO for Wave 5 as scoped**

Wave 5 rests on three promised benefits. After the spike:

| Promised benefit | Status |
|---|---|
| Retire the server-side mirror (~500-700 LOC), incl. the private-internals OSC-8 hack (T31) | **FALSIFIED.** No cell/style data is exposed. Best case is double emulation *and* permanent loss of OSC-8 hyperlinks. |
| Replace the 12-regex attention heuristic with real agent state (T29) | **PARTIAL / RISKY.** `blocked` is good. `working` depends on a remote manifest the version pin does not cover -- the bundled one reported a busy agent as idle for 75 s. `done` never fires. |
| Restart restore re-attaches the Claude conversation (T28/T33) | **UNPROVEN, and unreachable under the current launch mode.** Pane shape restores; the agent does not. Requires native-in-WSL Claude + the integration hook. |
| *(not in the plan)* Atomic text+Enter input | **REAL WIN.** `pane.send_input` solves a documented race in one call. |

Against those, the costs are concrete: no Windows binary at the pin (the
Node server cannot reach the socket as architected), one TCP/unix connection
per RPC, no push output stream (full-screen long-polling replaces a byte
stream), a new runtime dependency on a remotely-fetched detection manifest,
and a forced change of launch mode that drags Claude Code authentication
inside WSL with it.

The single benefit that clearly survives -- atomic input -- does not justify
a 4.0.0 architecture change. **Do not adopt herdr as the backbone now.**

### If the decision is to proceed anyway, the shape is forced

The spike leaves no genuine choices; each answer forces the next.

1. **Our side owns the grid.** herdr cannot drive the client. Keep
   `server.js:1016-1198` and the headless xterm mirror; feed it
   `pane.read {format:"ansi", source:"visible"}`. **T31 must be dropped**,
   and the OSC-8 feature (`:1099`) must be explicitly retired as a
   consequence -- write that down rather than discovering it in production.
2. **Launch natively inside WSL (`claude`), not `cmd.exe /c claude`.** This
   is the only mode where the integration hook can fire, which is the only
   route to session refs, restart resume, and hook-reported state.
   **Prerequisite: authenticate Claude Code inside WSL Ubuntu-24.04** -- an
   operator action, and a real change to the auth story. Until that is done,
   herdr buys nothing over dtach on restore.
3. **The Node server must move into WSL, or gain a bridge.** v0.8.0 ships no
   Windows binary; a Windows process cannot open a WSL2 unix socket. Moving
   the server into WSL is the cleaner option and folds neatly into T08's
   systemd unit, but it is a much bigger change than the plan assumes and
   interacts with PM2, Tailscale serve, and T09's logon task.
4. **Reconnect story:** long-poll `events.wait {pane_output_changed,
   min_revision}` -> `pane.read` -> re-render, with one connection per call
   and `revision` as the cursor. Hold a separate persistent connection for
   `events.subscribe {pane.agent_status_changed}` to drive notifications.
   On reconnect, `session.snapshot` re-enumerates panes; `pane.read
   {source:"recent"}` rehydrates scrollback.
5. **Pin harder than the binary.** Pin the protocol (19) and fail loudly on
   mismatch, *and* decide a policy for `agent-detection` manifests -- either
   vendor a known-good copy and disable `manifest_check`, or accept that
   notification behaviour changes without a deploy.

### Suggested re-plan

Take the win, drop the rest. Fold the atomic-input lesson into the existing
architecture: the same "one write, text+CR together" discipline
`pane.send_input` demonstrates can be applied directly to the current
`node-pty` path at `server.js:1671` and in W2's T12 keyboard handler, with no
new dependency. Revisit herdr when it has (a) a stable Windows build and
(b) structured grid or hyperlink output on the socket -- at which point the
mirror-retirement case can be re-tested rather than re-assumed.

---

## Probe scripts

| File | Purpose |
|---|---|
| `spike-herdr-setup.sh` | pinned v0.8.0 install + spike config |
| `spike-herdr-client.js` | minimal socket client (prototype of T27's `lib/herdr.js`) |
| `spike-herdr-schema.js` | static API-schema inspection (methods, read contract, grid search) |
| `spike-herdr-subscription.js` | subscription / event-match contract |
| `spike-herdr-q1-fidelity.js` | Q1 -- 16-combination fidelity matrix |
| `spike-herdr-q2-agentstate.js` | Q2 -- launch-mode detection probe |
| `spike-herdr-explain.js` | Q2 -- `agent.explain` rule-level diagnosis |
| `spike-herdr-fastwatch.js` | Q2 -- 200 ms agent-state sampler |
| `spike-herdr-q3-restart.sh` | Q3 -- before/after restart comparison |
| `spike-herdr-q4-input.js` | Q4 -- input atomicity methods A-E |
| `spike-herdr-step.js` | shared interactive pane driver |

All are run inside WSL Ubuntu-24.04 with the absolute herdr path. No code
from this wave ships.

## Residual unknowns

1. **True conversation resume** (Q3) -- untested; blocked on authenticating
   Claude Code inside WSL. This is the one open question that could change
   the verdict, and it is an operator action to unblock.
2. **`done` state** -- never observed; unclear whether it requires the
   integration hook.
3. **Windows preview channel** -- a Windows-native herdr build exists on
   preview and was not evaluated (out of scope for a v0.8.0 stable pin).
