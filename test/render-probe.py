"""
Renderer cost probe (T10 of .planning/ipad-apple-redesign.md, decision D9).

Measures what the two client renderers cost in Playwright WEBKIT at the
iPad Pro 11 profiles, on ONE deterministic synthetic stream, so the T11
renderer decision follows numbers rather than taste:

  grid   default: DOM rows of spans (app.js renderRow / applyGridFrame)
  xterm  ?renderer=xterm: xterm.js + WebglAddon -> CanvasAddon -> DOM,
         exactly as shipped (today this engages CANVAS -- see WEBGL_SHIM)
  xterm-webgl  the same, plus a harness-injected alias for the addon event
         app.js misnames, so the WebGL path app.js intended is measured too

Both modes receive the SAME logical content through the client's own
message dispatcher, handle(m) -- grid as 'snapshot' / 'frame' messages
(exactly the shape server.js buildSnapshot/buildFrame emits: full-width
runs, viewport rows only in frames), xterm as the equivalent ANSI through
'scrollback' / 'output'. Nothing in public/ is modified; all instrumentation
is injected from here (add_init_script / evaluate).

Stream (seed 1729): a snapshot (scrollback + viewport), then phases
  steady         600 frames, 1-6 rows each (bias to the bottom status block),
                 coloured runs (16/256/RGB, bold/underline), cursor moves;
                 delivered every 8 ms (faster than rAF, like token output)
  burst          60 full redraws (every viewport row), every 16 ms
  stream-scroll  120 one-line scrolls (every row shifts), every 16 ms
  reader-scroll  40 steps up 3 rows then 40 down, one per frame

Metrics per mode (each repeat runs two passes, so the DOM instrumentation
never inflates the timing numbers):
  timing pass   rAF-delta frame time p50/p95/max over the stream phases,
                frames with a gap > 50 ms, long tasks (> 50 ms: dispatch
                calls + per-frame rAF-callback batches, plus PerformanceObserver
                'longtask' where WebKit supports it), rAF script ms/frame,
                snapshot apply time (sync, and to the next painted frame),
                DOM node counts
  layout pass   forced synchronous layouts per frame (method below)

FORCED-LAYOUT METHOD: every DOM mutation entry point (Node/Element insert,
remove, replace; textContent/innerHTML/className; classList; style cssText,
setProperty and every CSSStyleDeclaration accessor the engine exposes)
bumps a write sequence. Every layout-reading API (offset*, client*,
scroll* getters, getBoundingClientRect, getClientRects) is wrapped; a read
counts as FORCED when a write happened since layout was last known clean.
Layout is known clean (a) after a forced read (the engine just laid out),
and (b) after each rendering step: a sentinel rAF posts a MessageChannel
task, which runs after update-the-rendering, and marks clean every write
made up to the end of that frame's last rAF callback.
LIMITS: it counts reads that REQUIRE a layout flush, not flushes WebKit
performed -- a mutation that cannot affect the queried box may be served
without relayout, so counts are an upper bound; getComputedStyle reads
(style flush) are not counted; style properties set through a path the
engine does not expose as a prototype accessor are missed (the JSON records
how many style setters were wrapped); canvas/WebGL draws never dirty layout,
which is correct, not a gap.

CAVEAT: WebKit on Windows, no iPad GPU, software/ANGLE compositing. The
absolute milliseconds are NOT iPad numbers. The signal is the comparison
between the modes and the forced-layout counts, which are engine-, not
GPU-, determined.

Run:
  py test/render-probe.py                       3 repeats, both profiles
  py test/render-probe.py --repeats 1 --out <dir>

Writes <out>/render-probe.json and prints a table of the median of repeats.
Exit: 0 ran (whatever the numbers), 2 harness broken.
"""
import importlib.util
import json
import os
import random
import statistics
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))

# Reuse the T01 harness: ARM (fake auth + session), free_port, wait_port.
_spec = importlib.util.spec_from_file_location("ipad_webkit", os.path.join(HERE, "ipad-webkit.py"))
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

DEFAULT_OUT = os.path.join(tempfile.gettempdir(), "cm-render-probe")
PROFILES = [
    ("ipad-pro-11-landscape", "iPad Pro 11 landscape"),
    ("ipad-pro-11", "iPad Pro 11"),
]
MODES = ["grid", "xterm", "xterm-webgl"]
# app.js subscribes webgl.onContextLost, but @xterm/addon-webgl names the event
# onContextLoss: the TypeError is caught and xterm drops to CanvasAddon on every
# platform. 'xterm-webgl' injects a one-line alias (harness only, public/
# untouched) so the path app.js INTENDED can be measured beside what ships.
WEBGL_SHIM = """() => {
  WebglAddon.WebglAddon.prototype.onContextLost = function (cb) { return this.onContextLoss(cb); };
}"""
SEED = 1729
SCROLLBACK_ROWS = 200
SNAPSHOT_REPS = 15
N_STEADY, N_BURST, N_SCROLL, READER_STEPS = 600, 60, 120, 40
SPACING = {"steady": 8, "burst": 16, "stream-scroll": 16}
STREAM_PHASES = ["steady", "burst", "stream-scroll", "reader-scroll"]
RGB_FLAG = 0x1000000

# --- synthetic stream (Python, seeded -> identical for both modes) ------------

WORDS = ("the harness binds a port so second run drives whichever server holds "
         "it change free_port instead of constant assert served build under test "
         "reading public/app.js grid frame cursor snapshot render row span colour "
         "tokens elapsed cogitating esc interrupt diff apply patch").split()
FGS = [None, None, None, 1, 2, 3, 4, 5, 6, 8, 208, 244, RGB_FLAG | 0x7AA2F7]
PREFIXES = [("* ", {"fg": 3}), ("+ ", {"fg": 2, "bold": True}), ("- ", {"fg": 1, "bold": True}),
            ("> ", {"fg": 4, "bold": True}), ("  ", {}), ("  ", {}), ("", {})]


def gen_row(rng, cols):
    runs, used = [], 0
    pre, sgr = rng.choice(PREFIXES)
    if pre:
        runs.append({"text": pre, "sgr": dict(sgr)})
        used += len(pre)
    target = rng.randint(cols // 4, cols - 2)
    while used < target:
        n = rng.randint(1, 6)
        text = " ".join(rng.choice(WORDS) for _ in range(n)) + " "
        text = text[: target - used]
        s = {}
        fg = rng.choice(FGS)
        if fg is not None:
            s["fg"] = fg
        if rng.random() < 0.15:
            s["bold"] = True
        if rng.random() < 0.05:
            s["underline"] = True
        if rng.random() < 0.03:
            s["bg"] = 236
        runs.append({"text": text, "sgr": s})
        used += len(text)
    runs.append({"text": " " * (cols - used), "sgr": {}})  # server pads to cols
    return runs


def build_stream(cols, rows):
    rng = random.Random(SEED)
    sb = [gen_row(rng, cols) for _ in range(SCROLLBACK_ROWS)]
    vp = [gen_row(rng, cols) for _ in range(rows)]
    cursor = {"row": rows - 1, "col": 2, "visible": True}
    snap = {"type": "snapshot", "session": 1, "cols": cols, "rows": rows,
            "scrollback": [{"row": i - len(sb), "runs": r} for i, r in enumerate(sb)],
            "viewport": [{"row": i, "runs": r} for i, r in enumerate(vp)],
            "cursor": cursor, "altScreen": False,
            "mouse": {"tracking": "none", "encoding": "default"}, "seq": 1}
    model = [list(r) for r in vp]
    phases = {}
    seq = [1]

    def frame(changed, cur):
        seq[0] += 1
        return {"changes": [{"row": i, "runs": model[i]} for i in sorted(changed)],
                "cursor": {"row": cur[0], "col": cur[1], "visible": True},
                "seq": seq[0], "scroll": False}

    out = []
    for _ in range(N_STEADY):
        k = rng.randint(1, 6)
        changed = set()
        while len(changed) < k:
            changed.add(rows - 1 - rng.randint(0, 7) if rng.random() < 0.7 else rng.randrange(rows))
        for i in changed:
            model[i] = gen_row(rng, cols)
        last = max(changed)
        out.append(frame(changed, (last, rng.randint(0, cols - 1))))
    phases["steady"] = out
    out = []
    for _ in range(N_BURST):
        for i in range(rows):
            model[i] = gen_row(rng, cols)
        out.append(frame(range(rows), (rng.randrange(rows), rng.randint(0, cols - 1))))
    phases["burst"] = out
    out = []
    for _ in range(N_SCROLL):
        model.pop(0)
        model.append(gen_row(rng, cols))
        f = frame(range(rows), (rows - 1, rng.randint(0, cols - 1)))
        f["scroll"] = True
        out.append(f)
    phases["stream-scroll"] = out
    return snap, phases


def ansi_runs(runs):
    out = []
    for r in runs:
        s, codes = r["sgr"] or {}, []
        if s.get("bold"):
            codes.append("1")
        if s.get("underline"):
            codes.append("4")
        for key, base, bright, ext in (("fg", 30, 90, 38), ("bg", 40, 100, 48)):
            v = s.get(key)
            if v is None:
                continue
            if v >= RGB_FLAG:
                c = v & 0xFFFFFF
                codes.append("%d;2;%d;%d;%d" % (ext, c >> 16, (c >> 8) & 255, c & 255))
            elif v < 8:
                codes.append(str(base + v))
            elif v < 16:
                codes.append(str(bright + v - 8))
            else:
                codes.append("%d;5;%d" % (ext, v))
        out.append("\x1b[%sm%s\x1b[0m" % (";".join(codes), r["text"]) if codes else r["text"])
    return "".join(out)


def to_messages(mode, snap, phases, rows):
    """The same logical stream as client messages for one mode."""
    if mode == "grid":
        msgs = {p: [dict(f, type="frame", session=1) for f in fs] for p, fs in phases.items()}
        for fs in msgs.values():
            for f in fs:
                f.pop("scroll", None)
        return snap, msgs
    lines = [ansi_runs(r["runs"]) for r in snap["scrollback"] + snap["viewport"]]
    xsnap = {"type": "scrollback", "session": 1, "data": "\n".join(lines)}
    msgs = {}
    for p, fs in phases.items():
        out = []
        for f in fs:
            c = f["cursor"]
            if f["scroll"]:
                data = "\x1b[%d;1H\n%s" % (rows, ansi_runs(f["changes"][-1]["runs"]))
            else:
                data = "".join("\x1b[%d;1H%s" % (ch["row"] + 1, ansi_runs(ch["runs"]))
                               for ch in f["changes"])
            data += "\x1b[%d;%dH" % (c["row"] + 1, c["col"] + 1)
            out.append({"type": "output", "session": 1, "data": data})
        msgs[p] = out
    return xsnap, msgs


# --- page instrumentation (injected; public/ is untouched) ---------------------

INSTRUMENT = r"""
(() => {
  const LAYOUT = !!window.__PROBE_LAYOUT;
  const P = window.__probe = {
    phase: 'idle', frames: [], batches: [], work: [], frameStart: 0, workPhase: 'idle', tasks: [], longtasks: [],
    writeSeq: 0, cleanSeq: 0, lastRafEndSeq: 0, cnt: {},
    gl: [], styleSettersWrapped: 0, layout: LAYOUT,
    longtaskSupported: false,
  };
  const now = () => performance.now();
  const bump = (k, name) => {
    const c = P.cnt[P.phase] || (P.cnt[P.phase] = { reads: 0, forced: 0, writes: 0, forcedBy: {} });
    if (k === 'w') { c.writes++; return; }
    c.reads++;
    if (k === 'f') { c.forced++; c.forcedBy[name] = (c.forcedBy[name] || 0) + 1; }
  };

  // rAF: time every callback, grouped per frame (one frame = one timestamp).
  const rawRAF = window.requestAnimationFrame.bind(window);
  let curTs = -1, curMs = 0, curPhase = 'idle';
  const flush = () => { if (curTs >= 0) P.batches.push([curPhase, curMs]); };
  window.requestAnimationFrame = function (cb) {
    return rawRAF(function (ts) {
      if (ts !== curTs) {
        flush(); curTs = ts; curMs = 0; curPhase = P.phase;
        P.frameStart = now(); P.workPhase = P.phase;
      }
      const t0 = now();
      try { return cb(ts); } finally { curMs += now() - t0; P.lastRafEndSeq = P.writeSeq; }
    });
  };

  // Render hook: a task posted from a rAF callback runs after the rendering
  // step, so every write made up to the frame's last rAF callback is laid out.
  const mc = new MessageChannel();
  // The same task closes the frame's main-thread work: first rAF callback ->
  // after style/layout/paint (plus any task that queued ahead of it).
  mc.port1.onmessage = () => {
    if (P.lastRafEndSeq > P.cleanSeq) P.cleanSeq = P.lastRafEndSeq;
    if (P.frameStart) { P.work.push([P.workPhase, now() - P.frameStart]); P.frameStart = 0; }
  };
  let lastTs = 0;
  P.start = () => {
    lastTs = 0;
    const loop = (ts) => {
      if (lastTs) P.frames.push([P.phase, ts - lastTs]);
      lastTs = ts;
      mc.port2.postMessage(0);
      window.requestAnimationFrame(loop);
    };
    window.requestAnimationFrame(loop);
  };

  try {
    P.longtaskSupported = (PerformanceObserver.supportedEntryTypes || []).includes('longtask');
    if (P.longtaskSupported) new PerformanceObserver(l => {
      for (const e of l.getEntries()) P.longtasks.push([P.phase, e.duration]);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  // Which xterm renderer engaged: record every context request.
  const rawGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    const ctx = rawGetContext.apply(this, arguments);
    P.gl.push({ type: String(type), ok: !!ctx, el: this });
    return ctx;
  };

  if (!LAYOUT) return;

  const dirty = () => { P.writeSeq++; bump('w'); };
  const wrapM = (proto, names) => { for (const n of names) {
    const f = proto && proto[n];
    if (typeof f !== 'function') continue;
    proto[n] = function () { dirty(); return f.apply(this, arguments); };
  } };
  const wrapSet = (proto, prop) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.configurable) return false;
    Object.defineProperty(proto, prop, Object.assign({}, d, {
      set(v) { dirty(); d.set.call(this, v); } }));
    return true;
  };
  wrapM(Node.prototype, ['appendChild', 'insertBefore', 'removeChild', 'replaceChild']);
  wrapM(Element.prototype, ['replaceWith', 'before', 'after', 'remove', 'append', 'prepend',
    'replaceChildren', 'setAttribute', 'removeAttribute', 'toggleAttribute',
    'insertAdjacentElement', 'insertAdjacentHTML', 'insertAdjacentText']);
  wrapM(CharacterData.prototype, ['appendData', 'replaceData', 'insertData', 'deleteData']);
  wrapM(DOMTokenList.prototype, ['add', 'remove', 'toggle', 'replace']);
  wrapM(CSSStyleDeclaration.prototype, ['setProperty', 'removeProperty']);
  wrapSet(Node.prototype, 'textContent'); wrapSet(Node.prototype, 'nodeValue');
  wrapSet(CharacterData.prototype, 'data');
  wrapSet(Element.prototype, 'innerHTML'); wrapSet(Element.prototype, 'className');
  wrapSet(HTMLElement.prototype, 'innerText');
  const styleProtos = [CSSStyleDeclaration.prototype];
  if (window.CSSStyleProperties) styleProtos.push(CSSStyleProperties.prototype);
  for (const proto of styleProtos) for (const k of Object.getOwnPropertyNames(proto)) {
    if (wrapSet(proto, k)) P.styleSettersWrapped++;
  }

  const read = (name) => {
    if (P.writeSeq > P.cleanSeq) { bump('f', name); P.cleanSeq = P.writeSeq; }
    else bump('r', name);
  };
  const wrapGet = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, Object.assign({}, d, {
      get() { read(prop); return d.get.call(this); } }));
  };
  for (const p of ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'offsetParent'])
    wrapGet(HTMLElement.prototype, p);
  for (const p of ['clientTop', 'clientLeft', 'clientWidth', 'clientHeight',
                   'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight'])
    wrapGet(Element.prototype, p);
  for (const n of ['getBoundingClientRect', 'getClientRects']) {
    const f = Element.prototype[n];
    Element.prototype[n] = function () { read(n); return f.apply(this, arguments); };
  }
})();
"""

# Resolves the renderer that actually drew the xterm terminal.
XTERM_RENDERER = """() => {
  const P = window.__probe;
  const inTerm = g => g.el.isConnected && g.el.closest('.xterm');
  const live = P.gl.filter(inTerm);
  const webgl = live.some(g => g.ok && /webgl/.test(g.type));
  const c2d = live.some(g => g.ok && g.type === '2d');
  const domRows = document.querySelectorAll('.xterm-rows > div').length;
  const probe = document.createElement('canvas');
  return {
    engaged: webgl ? 'webgl' : (c2d ? 'canvas' : (domRows ? 'dom' : 'unknown')),
    contextRequests: P.gl.map(g => g.type + (g.ok ? ':ok' : ':null')
                                  + (inTerm(g) ? '@xterm' : '')),
    webgl2Available: !!probe.getContext('webgl2'),
    xtermCanvases: document.querySelectorAll('.xterm canvas').length,
    xtermDomRows: domRows,
  };
}"""

SETUP = """async (a) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(500);   // switchTo's fit (xterm) / doResize (grid) timers
  const sid = activeSession;
  if (a.mode === 'grid') {
    const d = computeGridDims(gridTerms[sid]);
    return { cols: d.cols, rows: d.rows };
  }
  const t = terms[sid];
  const natural = { cols: t.cols, rows: t.rows };
  if (a.cols) t.resize(a.cols, a.rows);
  await sleep(200);
  return { cols: t.cols, rows: t.rows, natural };
}"""

DRIVE = """async (D) => {
  const P = window.__probe;
  const sid = activeSession;
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async n => { for (let i = 0; i < n; i++) await raf(); };
  const nodes = () => {
    const w = document.getElementById('tw-' + sid);
    return { document: document.getElementsByTagName('*').length,
             terminal: w ? w.getElementsByTagName('*').length : 0 };
  };
  P.start();
  await settle(5);
  P.phase = 'baseline';   // idle cadence: the floor every frame time sits on
  await settle(60);
  P.phase = 'idle';

  const snaps = [];
  for (let i = 0; i < D.snapReps; i++) {
    P.phase = 'snapshot';
    const t0 = performance.now();
    if (D.mode === 'grid') {
      handle(D.snap);
    } else {
      // The scrollback path writes in 50-line chunks and ends with
      // term.scrollToBottom(); that call marks the snapshot applied.
      await new Promise(res => {
        const t = terms[sid], orig = t.scrollToBottom;
        t.scrollToBottom = function () { t.scrollToBottom = orig; orig.apply(this, arguments); res(); };
        handle(D.snap);
      });
    }
    const tSync = performance.now();
    await raf(); await raf();
    snaps.push({ sync: tSync - t0, paint: performance.now() - t0 });
    P.phase = 'idle';
    await settle(2);
  }
  const nodesAfterSnapshot = nodes();

  let nodesAfterSteady = null;
  for (const phase of ['steady', 'burst', 'stream-scroll']) {
    const items = D.msgs[phase], sp = D.spacing[phase];
    P.phase = phase;
    const t0 = performance.now();
    let i = 0;
    await new Promise(res => {
      const tick = () => {
        const el = performance.now() - t0;
        while (i < items.length && i * sp <= el) {
          const s = performance.now();
          handle(items[i]);
          P.tasks.push([phase, performance.now() - s]);
          i++;
        }
        if (i < items.length) setTimeout(tick, Math.max(0, i * sp - (performance.now() - t0)));
        else res();
      };
      tick();
    });
    await settle(4);
    if (phase === 'steady') nodesAfterSteady = nodes();
    P.phase = 'idle';
    await settle(2);
  }

  // Reader scroll: a person dragging back through scrollback and returning.
  let pos = 0, rowH = 0, g = null;
  if (D.mode === 'grid') { g = gridTerms[sid]; rowH = g.rowHeight; pos = g.wrap.scrollTop; }
  P.phase = 'reader-scroll';
  for (const dir of [-1, 1]) for (let s = 0; s < D.readerSteps; s++) {
    if (g) { pos = Math.max(0, pos + dir * 3 * rowH); g.wrap.scrollTop = pos; }
    else terms[sid].scrollLines(dir * 3);
    await raf();
  }
  await settle(4);
  P.phase = 'idle';
  await settle(2);
  return { snaps, nodesAfterSnapshot, nodesAfterSteady };
}"""

COLLECT = """() => {
  const P = window.__probe;
  return { frames: P.frames, batches: P.batches, work: P.work, tasks: P.tasks, longtasks: P.longtasks,
           cnt: P.cnt, styleSettersWrapped: P.styleSettersWrapped,
           longtaskSupported: P.longtaskSupported };
}"""


# --- stats -----------------------------------------------------------------------

def pct(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(round(p / 100.0 * len(s) + 0.5)) - 1))]


def r2(x):
    return None if x is None else round(x, 2)


def run_once(p, browser, base, device, mode, dims, stream, layout):
    ctx = browser.new_context(**p.devices[device])
    ctx.add_init_script("window.__PROBE_LAYOUT = %s;" % ("true" if layout else "false"))
    ctx.add_init_script(INSTRUMENT)
    page = ctx.new_page()
    errors, warns = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: (errors if m.type == "error" else warns).append(m.text)
            if m.type in ("error", "warning") else None)
    page.on("dialog", lambda d: d.accept())
    page.goto(base + ("/" if mode == "grid" else "/?renderer=xterm"), wait_until="load")
    page.wait_for_function(
        "() => getComputedStyle(document.getElementById('totp-section')).display !== 'none'"
        " || getComputedStyle(document.getElementById('setup-msg')).display !== 'none'",
        timeout=10000)
    if mode == "xterm-webgl":
        page.evaluate(WEBGL_SHIM)
    page.evaluate(H.ARM)
    got = page.evaluate(SETUP, {"mode": mode, "cols": dims and dims["cols"],
                                "rows": dims and dims["rows"]})
    if dims is None:           # dims preflight
        ctx.close()
        return got
    snap, msgs = to_messages(mode, *stream, rows=dims["rows"])
    res = page.evaluate(DRIVE, {"mode": mode, "snap": snap, "msgs": msgs,
                                "spacing": SPACING, "snapReps": SNAPSHOT_REPS,
                                "readerSteps": READER_STEPS})
    raw = page.evaluate(COLLECT)
    renderer = page.evaluate(XTERM_RENDERER) if mode != "grid" else {"engaged": "dom-grid"}
    ctx.close()
    return {"dims": got, "res": res, "raw": raw, "renderer": renderer,
            "errors": errors, "warnings": sorted(set(warns))}


def summarise(timing, layout):
    raw, res = timing["raw"], timing["res"]
    fr = [d for ph, d in raw["frames"] if ph in STREAM_PHASES]
    per_phase = {}
    for ph in STREAM_PHASES:
        d = [x for p_, x in raw["frames"] if p_ == ph]
        per_phase[ph] = {"frames": len(d), "p50": r2(pct(d, 50)), "p95": r2(pct(d, 95)),
                         "max": r2(max(d) if d else None)}
    batches = [ms for ph, ms in raw["batches"] if ph in STREAM_PHASES]
    work = [ms for ph, ms in raw["work"] if ph in STREAM_PHASES]
    base_fr = [d for ph, d in raw["frames"] if ph == "baseline"]
    tasks = [ms for ph, ms in raw["tasks"] if ph in STREAM_PHASES]
    snaps_sync = [s["sync"] for s in res["snaps"]]
    snaps_paint = [s["paint"] for s in res["snaps"]]

    lraw = layout["raw"]
    lframes = {ph: sum(1 for p_, _ in lraw["frames"] if p_ == ph) for ph in STREAM_PHASES + ["snapshot"]}
    forced = {}
    forced_by = {}
    for ph in STREAM_PHASES + ["snapshot"]:
        c = lraw["cnt"].get(ph, {"forced": 0, "reads": 0, "forcedBy": {}})
        n = max(1, lframes[ph])
        forced[ph] = {"forced": c["forced"], "reads": c["reads"], "frames": lframes[ph],
                      "forcedPerFrame": r2(c["forced"] / float(n))}
        for k, v in c.get("forcedBy", {}).items():
            forced_by[k] = forced_by.get(k, 0) + v
    stream_forced = sum(forced[ph]["forced"] for ph in STREAM_PHASES)
    stream_frames = max(1, sum(lframes[ph] for ph in STREAM_PHASES))
    snap_forced = forced["snapshot"]["forced"] / float(SNAPSHOT_REPS)
    return {
        "frameP50": r2(pct(fr, 50)), "frameP95": r2(pct(fr, 95)), "frameMax": r2(max(fr) if fr else None),
        "framesOver50ms": sum(1 for d in fr if d > 50),
        "longTasks": sum(1 for x in batches + tasks if x > 50)
                     + sum(1 for ph, d in raw["longtasks"] if ph in STREAM_PHASES),
        "idleFrameP50": r2(pct(base_fr, 50)),
        "rafScriptP95": r2(pct(batches, 95)),
        "frameWorkP50": r2(pct(work, 50)), "frameWorkP95": r2(pct(work, 95)),
        "forcedLayoutsPerFrame": r2(stream_forced / float(stream_frames)),
        "forcedLayoutsPerSnapshot": r2(snap_forced),
        "snapshotSyncP50": r2(pct(snaps_sync, 50)), "snapshotSyncP95": r2(pct(snaps_sync, 95)),
        "snapshotPaintP50": r2(pct(snaps_paint, 50)), "snapshotPaintP95": r2(pct(snaps_paint, 95)),
        "domNodes": res["nodesAfterSteady"]["document"],
        "terminalNodes": res["nodesAfterSteady"]["terminal"],
        "perPhaseFrameMs": per_phase,
        "forcedByPhase": forced,
        "forcedByApi": forced_by,
        "longtaskObserverSupported": raw["longtaskSupported"],
        "styleSettersWrapped": lraw["styleSettersWrapped"],
    }


TABLE_KEYS = [
    ("frameP50", "frame p50 ms"), ("frameP95", "frame p95 ms"), ("frameMax", "frame max ms"),
    ("idleFrameP50", "idle frame p50 ms"),
    ("framesOver50ms", "frames >50ms"), ("longTasks", "long tasks >50ms"),
    ("rafScriptP95", "rAF script p95 ms"),
    ("frameWorkP50", "main-thread work p50"), ("frameWorkP95", "main-thread work p95"),
    ("forcedLayoutsPerFrame", "forced layouts/frame"),
    ("forcedLayoutsPerSnapshot", "forced layouts/snapshot"),
    ("snapshotSyncP50", "snapshot sync p50 ms"), ("snapshotSyncP95", "snapshot sync p95 ms"),
    ("snapshotPaintP50", "snapshot->paint p50"), ("snapshotPaintP95", "snapshot->paint p95"),
    ("domNodes", "DOM nodes (doc)"), ("terminalNodes", "DOM nodes (term)"),
]


def median_of(runs, key):
    xs = [r[key] for r in runs if r.get(key) is not None]
    return r2(statistics.median(xs)) if xs else None


def main():
    args = sys.argv[1:]
    out = args[args.index("--out") + 1] if "--out" in args else DEFAULT_OUT
    repeats = int(args[args.index("--repeats") + 1]) if "--repeats" in args else 3
    os.makedirs(out, exist_ok=True)

    port = H.free_port()
    srv = subprocess.Popen(["node", os.path.join(HERE, "static-server.js"), H.PUBLIC, str(port)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not H.wait_port(port):
        print("HARNESS BROKEN: static server did not start")
        srv.kill()
        return 2
    base = "http://127.0.0.1:%d" % port
    report = {
        "caveat": "WebKit on Windows (no iPad GPU). Absolute ms are not iPad numbers; "
                  "the mode comparison and forced-layout counts are the signal.",
        "seed": SEED, "repeats": repeats,
        "stream": {"scrollbackRows": SCROLLBACK_ROWS, "snapshotReps": SNAPSHOT_REPS,
                   "steady": N_STEADY, "burst": N_BURST, "streamScroll": N_SCROLL,
                   "readerScrollSteps": READER_STEPS * 2, "deliverySpacingMs": SPACING},
        "forcedLayoutMethod": "writes (DOM mutation + style setters) bump a sequence; a wrapped "
                              "layout read (offset*/client*/scroll* getters, getBoundingClientRect, "
                              "getClientRects) is forced if a write happened since layout was last "
                              "clean; clean = after a forced read, or after the rendering step "
                              "(MessageChannel task posted from a sentinel rAF). Upper bound; "
                              "getComputedStyle not counted; separate pass from timing.",
        "profiles": {},
    }
    try:
        with sync_playwright() as p:
            browser = p.webkit.launch()
            for slug, device in PROFILES:
                dims = run_once(p, browser, base, device, "grid", None, None, False)
                stream = build_stream(dims["cols"], dims["rows"])
                prof = {"device": device, "gridDims": dims, "modes": {}}
                for mode in MODES:
                    runs, meta = [], None
                    for rep in range(repeats):
                        t = run_once(p, browser, base, device, mode, dims, stream, False)
                        l = run_once(p, browser, base, device, mode, dims, stream, True)
                        runs.append(summarise(t, l))
                        meta = {"renderer": t["renderer"], "dims": t["dims"],
                                "pageErrors": sorted(set(t["errors"] + l["errors"])),
                                "warnings": t["warnings"]}
                        print("  %s %s rep %d: p95 %s ms, forced/frame %s, renderer %s"
                              % (slug, mode, rep + 1, runs[-1]["frameP95"],
                                 runs[-1]["forcedLayoutsPerFrame"], t["renderer"]["engaged"]))
                    med = {k: median_of(runs, k) for k, _ in TABLE_KEYS}
                    prof["modes"][mode] = {"median": med, "runs": runs, **meta}
                report["profiles"][slug] = prof
            browser.close()
    except Exception as e:  # the harness itself broke
        print("HARNESS BROKEN: %s" % e)
        return 2
    finally:
        srv.kill()

    path = os.path.join(out, "render-probe.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)

    print("\n" + report["caveat"])
    for slug, prof in report["profiles"].items():
        ms = prof["modes"]
        print("\n%s  %sx%s  (median of %d)  engaged: %s"
              % (slug, prof["gridDims"]["cols"], prof["gridDims"]["rows"], repeats,
                 ", ".join("%s=%s" % (m, ms[m]["renderer"]["engaged"]) for m in MODES)))
        print("  %-26s" % "metric" + "".join("%14s" % m for m in MODES))
        for k, label in TABLE_KEYS:
            print("  %-26s" % label + "".join("%14s" % ms[m]["median"][k] for m in MODES))
    print("\nJSON -> %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
