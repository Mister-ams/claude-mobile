"""
iPad window emulation harness.

Purpose: let changes to the client be SEEN and MEASURED here before the
operator is ever asked to look at them. Drives the real client at real iPad
viewports, feeds it realistic terminal content, writes PNGs, and measures the
two complaints that motivated it:

  cramped        -- how much of the screen the terminal actually gets
  moves around   -- how far content jumps when a snapshot or resize arrives

Nothing here reasons about the source; every number is observed from the
running client.

SCOPE: this drives a STATIC server (test/static-server.js) and injects
synthetic snapshots. There is no auth, no WebSocket and no session backend
behind it, so it cannot tell you whether dtach or herdr works, and pointing it
at a live server's port would only serve that port's static files. For
anything below the client, use test/live-session-verify.py -- it authenticates
for real against a running server and drives a real session.

Run:
  C:\\Users\\MRAL-\\AppData\\Local\\Python\\bin\\python.exe test/ipad-emulator.py
  ... --shots-only     screenshots, skip the shift probes
  ... --out <dir>      where PNGs land (default: scratchpad)
"""
import json
import os
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, "public")

DEFAULT_OUT = os.path.join(
    os.environ.get("TEMP", "/tmp"),
    "claude", "C--Users-MRAL--Projects-loomi-os",
    "21e25eab-3c6b-4ec6-a7b9-19ec052bb419", "scratchpad", "ipad-shots",
)

# Real iPad CSS viewports. Safari reports these in CSS px; deviceScaleFactor 2
# matches the physical panel so text rendering is representative.
VIEWPORTS = [
    ("ipad11-landscape", 1194, 834),
    ("ipad11-portrait", 834, 1194),
    ("ipad13-landscape", 1366, 1024),
    # Phone is a regression guard, not a target: the rail must not reach it,
    # and #app's visibility mechanism is shared by every viewport.
    ("phone", 390, 844),
]


def free_port():
    """Never hardcode. A bound port silently drives someone else's server."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_port(p, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            socket.create_connection(("127.0.0.1", p), 0.4).close()
            return True
        except OSError:
            time.sleep(0.15)
    return False


# --- realistic content -------------------------------------------------------
# Shaped like a Claude Code session: box drawing, colour, a status line, and
# enough scrollback that virtualisation and spacers are actually exercised.

def _run(text, **sgr):
    return {"text": text, "sgr": (sgr or None)}


def make_rows(n_scrollback=600, cols=120):
    rows = []
    body = [
        [_run("> ", fg=4, bold=True), _run("summarise the failing test and propose a fix")],
        [_run("")],
        [_run("* ", fg=3), _run("Reading "), _run("test/w2-ipad-verify.py", fg=6, underline=True)],
        [_run("* ", fg=3), _run("Reading "), _run("public/app.js", fg=6, underline=True)],
        [_run("")],
        [_run("The harness binds a hardcoded port, so a second run drives")],
        [_run("whichever server already holds 3462. Two changes:")],
        [_run("")],
        [_run("  1. ", fg=3), _run("free_port() instead of the constant")],
        [_run("  2. ", fg=3), _run("assert the served build is the one under test")],
        [_run("")],
        [_run("+ ", fg=2, bold=True), _run("def free_port():", fg=2)],
        [_run("+ ", fg=2, bold=True), _run("    s = socket.socket()", fg=2)],
        [_run("- ", fg=1, bold=True), _run("PORT = 3462", fg=1)],
        [_run("")],
        [_run("=" * min(cols - 2, 78), fg=8)],
        [_run("  Tokens: ", fg=8), _run("18.4k", bold=True), _run("   Elapsed: ", fg=8), _run("42s")],
    ]
    idx = -n_scrollback
    for i in range(n_scrollback):
        src = body[i % len(body)]
        rows.append({"row": idx + i, "runs": [dict(r) for r in src]})
    return rows


def build_snapshot(viewport_rows, cols):
    scrollback = make_rows(600, cols)
    viewport = []
    for i in range(viewport_rows):
        if i == viewport_rows - 2:
            runs = [_run("* ", fg=5, bold=True), _run("Cogitating... ", fg=5),
                    _run("(esc to interrupt)", fg=8)]
        elif i == viewport_rows - 1:
            runs = [_run("> ", fg=4, bold=True), _run("_")]
        else:
            src = make_rows(1, cols)[0]["runs"]
            runs = [dict(r) for r in src]
        viewport.append({"row": i, "runs": runs})
    return {
        "scrollback": scrollback,
        "viewport": viewport,
        "cursor": {"row": viewport_rows - 1, "col": 2, "visible": True},
    }


ARM = """() => {
  localStorage.setItem('cm-hw-keyboard', 'on');
  window.__sent = [];
  queueSend = (o) => { window.__sent.push(o); };
  authScreen.style.display = 'none';
  appEl.classList.add('shown');   // must mirror production, not set display inline
  ws = { readyState: 1, send() {} };
  sessionList = [
    { id: 1, name: 'LOOMI OS', dir: '/mnt/c/Users/MRAL-/Projects/loomi-os' },
    { id: 2, name: 'claude-mobile', dir: '/mnt/c/Users/MRAL-/Projects/claude-mobile' },
    { id: 3, name: 'herdr', dir: '/root/work' }
  ];
  activeSession = null;
  switchTo(1);
  applyHwKeyboard();
  return true;
}"""

# Terminal area vs total chrome. This is the "cramped" number.
MEASURE = """() => {
  const wrap = document.querySelector('.term-wrap') || document.querySelector('.grid-term');
  const grid = document.querySelector('.grid-term') || wrap;
  const r = wrap ? wrap.getBoundingClientRect() : null;
  const row = document.querySelector('.grid-row');
  const cs = row ? getComputedStyle(row) : null;
  const probe = document.createElement('span');
  if (grid) {
    probe.textContent = '0'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    grid.appendChild(probe);
  }
  const charW = probe.getBoundingClientRect().width / 100 || 0;
  if (probe.parentNode) probe.remove();
  const rowH = row ? row.getBoundingClientRect().height : 0;
  const ids = ['#header', '#tabs', '#qbar', '#input-bar'];
  const chrome = {};
  for (const id of ids) {
    const el = document.querySelector(id);
    const vis = el && getComputedStyle(el).display !== 'none';
    const b = vis ? el.getBoundingClientRect() : null;
    chrome[id] = b ? (Math.round(b.width) + 'x' + Math.round(b.height)) : 'hidden';
  }
  // Summing bar heights is wrong once they sit side by side, so derive the
  // real cost from what the terminal did NOT get.
  const vChrome = r ? Math.round(innerHeight - r.height) : null;
  const hChrome = r ? Math.round(innerWidth - r.width) : null;
  const layout = getComputedStyle(document.getElementById('app')).display;
  return {
    viewport: { w: innerWidth, h: innerHeight },
    layout: layout,
    terminal: r ? { w: Math.round(r.width), h: Math.round(r.height),
                    top: Math.round(r.top), left: Math.round(r.left) } : null,
    fontSize: cs ? cs.fontSize : null,
    rowHeight: +rowH.toFixed(2),
    charWidth: +charW.toFixed(3),
    cols: charW ? Math.floor((r ? r.width : 0) / charW) : 0,
    rows: rowH ? Math.floor((r ? r.height : 0) / rowH) : 0,
    chrome: chrome,
    verticalChromePx: vChrome,
    horizontalChromePx: hChrome,
    terminalPct: r ? Math.round(r.height / innerHeight * 100) : null
  };
}"""


def main():
    args = sys.argv[1:]
    out = DEFAULT_OUT
    if "--out" in args:
        out = args[args.index("--out") + 1]
    shots_only = "--shots-only" in args
    os.makedirs(out, exist_ok=True)

    port = free_port()
    srv = subprocess.Popen(
        ["node", os.path.join(HERE, "static-server.js"), PUBLIC, str(port), "tight"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_port(port):
        print("FAIL: static server did not start")
        srv.kill()
        return 1
    base = "http://127.0.0.1:%d" % port
    print("serving %s on %s\n" % (PUBLIC, base))

    report = {}
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for name, w, h in VIEWPORTS:
                ctx = b.new_context(viewport={"width": w, "height": h},
                                    device_scale_factor=2, is_mobile=False)
                page = ctx.new_page()
                errs = []
                page.on("pageerror", lambda e: errs.append(str(e)))
                page.on("dialog", lambda d: d.accept())
                page.goto(base + "/", wait_until="load")
                page.wait_for_timeout(700)
                page.evaluate(ARM)
                page.wait_for_timeout(300)

                m0 = page.evaluate(MEASURE)
                snap = build_snapshot(max(10, m0["rows"] or 40), m0["cols"] or 100)
                page.evaluate(
                    "(s) => { applyGridSnapshot(gridTerms[activeSession], s); }", snap)
                page.wait_for_timeout(500)

                m = page.evaluate(MEASURE)
                shot = os.path.join(out, "%s.png" % name)
                page.screenshot(path=shot)
                entry = {"metrics": m, "screenshot": shot, "pageerrors": errs[:3]}

                if not shots_only:
                    # Both halves matter. Holding position while scrolled up is
                    # the fix; still following output while at the bottom is the
                    # behaviour the fix must not break.
                    entry["shift"] = page.evaluate("""(s) => {
                      const g = gridTerms[activeSession];

                      // (a) reader is scrolled up -- must NOT move
                      g.wrap.scrollTop = Math.max(0, g.wrap.scrollHeight * 0.4);
                      const parked = g.wrap.scrollTop;
                      applyGridSnapshot(g, s);
                      const afterUp = g.wrap.scrollTop;

                      // (b) reader is at the bottom -- must STILL follow
                      g.wrap.scrollTop = g.wrap.scrollHeight;
                      applyGridSnapshot(g, s);
                      const afterBottom = g.wrap.scrollTop;
                      const maxScroll = g.wrap.scrollHeight - g.wrap.clientHeight;

                      return {
                        parkedAt: Math.round(parked),
                        afterSnapshot: Math.round(afterUp),
                        jumpedPx: Math.round(afterUp - parked),
                        heldPosition: Math.abs(afterUp - parked) < 4,
                        followsAtBottom: Math.abs(afterBottom - maxScroll) < 4,
                        bottomGapPx: Math.round(maxScroll - afterBottom)
                      };
                    }""", snap)

                report[name] = entry
                ms = entry["metrics"]
                print("%-18s %dx%d   layout=%s" % (name, w, h, ms["layout"]))
                print("   terminal   %sx%s px  (%s%% of height)"
                      % (ms["terminal"]["w"], ms["terminal"]["h"], ms["terminalPct"]))
                print("   grid       %s cols x %s rows @ %s"
                      % (ms["cols"], ms["rows"], ms["fontSize"]))
                print("   chrome     %spx vertical, %spx horizontal"
                      % (ms["verticalChromePx"], ms["horizontalChromePx"]))
                print("   bars       %s" % ms["chrome"])
                if "shift" in entry:
                    s = entry["shift"]
                    held = "HELD" if s["heldPosition"] else "JUMPED %+dpx" % s["jumpedPx"]
                    foll = "FOLLOWS" if s["followsAtBottom"] else "STUCK %dpx short" % s["bottomGapPx"]
                    print("   snapshot, scrolled up:  %s" % held)
                    print("   snapshot, at bottom:    %s" % foll)
                if errs:
                    print("   pageerrors %s" % errs[:2])
                print("   shot       %s" % shot)
                print()
                ctx.close()
            b.close()
    finally:
        srv.kill()

    with open(os.path.join(out, "metrics.json"), "w") as f:
        json.dump(report, f, indent=2)
    print("metrics -> %s" % os.path.join(out, "metrics.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
