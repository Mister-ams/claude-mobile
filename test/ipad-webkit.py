"""
WebKit iPad static harness (T01 of .planning/ipad-apple-redesign.md).

Drives the real client in Playwright WEBKIT (not Chromium) at the iPad
device profiles, over test/static-server.js (production CSP, no auth, no
WebSocket, no session backend -- D6). For every profile it captures:

  auth       the sign-in screen as the client renders it on load
  app        the app shell with a faked session and synthetic terminal content
  settings   the app shell with the settings panel opened by a click

and writes <profile>-<screen>.png plus metrics.json to --out.

GATE: exits non-zero on any console error, uncaught page error, CSP
violation (securitypolicyviolation), or a CSP that no longer matches
server.js. The only tolerated console error is listed by EXACT text in
BENIGN_CONSOLE below -- never add a pattern there, and never add a message
that describes a real defect.

BASELINE: --baseline copies the PNGs + metrics into test/baseline/ipad-webkit/
(committed). The default run compares metrics to that baseline and PRINTS the
deltas; deltas never fail the run, because later tasks change the UI on
purpose.

SELF-TEST: --self-test injects one fault of each gated kind (an inline script
the CSP must refuse, a console.error, an uncaught exception) into the first
profile. Expected exit: 1 with all three caught. Exit 2 means the gate missed
an injected fault -- the gate itself is broken.

Windows note (D5): WebKit on Windows reports navigator.maxTouchPoints = 0 even
with has_touch, so clicks here arrive as mouse events. That is recorded in the
metrics, not treated as a failure; touch, the on-screen keyboard and pinch
stay real-iPad checks.

Run:
  py test/ipad-webkit.py                 gate + metrics + deltas vs baseline
  py test/ipad-webkit.py --baseline      also (re)write test/baseline/ipad-webkit/
  py test/ipad-webkit.py --self-test     prove the gate fires (exits non-zero)
  py test/ipad-webkit.py --out <dir>     where PNGs + metrics land

Exit codes: 0 clean, 1 gate findings, 2 harness broken (server did not start,
or --self-test fault not caught).
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, "public")
BASELINE = os.path.join(HERE, "baseline", "ipad-webkit")
DEFAULT_OUT = os.path.join(tempfile.gettempdir(), "cm-ipad-webkit")

PROFILES = [
    ("ipad-pro-11", "iPad Pro 11"),
    ("ipad-pro-11-landscape", "iPad Pro 11 landscape"),
    ("ipad-gen-11", "iPad (gen 11)"),
    ("ipad-gen-11-landscape", "iPad (gen 11) landscape"),
]

# Exact console texts known to be benign in WebKit. Exact match only.
BENIGN_CONSOLE = {
    # index.html's viewport meta carries interactive-widget=resizes-content
    # for Chromium-based browsers; WebKit does not know the key and says so.
    'Viewport argument key "interactive-widget" not recognized and ignored.',
}

SELF_TEST_MARK = "ipad-webkit self-test"

MIN_TAP = 44  # CSS px; Apple HIG minimum hit target (44x44 pt)


def free_port():
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


def server_js_csp():
    """The production policy, read from server.js -- the parity oracle."""
    src = open(os.path.join(ROOT, "server.js"), encoding="utf-8").read()
    m = re.search(r"setHeader\('Content-Security-Policy',\s*\[(.*?)\]\.join\('; '\)",
                  src, re.S)
    if not m:
        return None
    body = "\n".join(l for l in m.group(1).splitlines()
                     if not l.strip().startswith("//"))
    return "; ".join(re.findall(r'"([^"]+)"', body))


# --- synthetic terminal content (shape borrowed from ipad-emulator.py) -------

def _run(text, **sgr):
    return {"text": text, "sgr": (sgr or None)}


BODY = [
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
    [_run("=" * 78, fg=8)],
    [_run("  Tokens: ", fg=8), _run("18.4k", bold=True), _run("   Elapsed: ", fg=8), _run("42s")],
]


def build_snapshot(viewport_rows):
    scrollback = [{"row": -600 + i, "runs": [dict(r) for r in BODY[i % len(BODY)]]}
                  for i in range(600)]
    viewport = []
    for i in range(viewport_rows):
        if i == viewport_rows - 2:
            runs = [_run("* ", fg=5, bold=True), _run("Cogitating... ", fg=5),
                    _run("(esc to interrupt)", fg=8)]
        elif i == viewport_rows - 1:
            runs = [_run("> ", fg=4, bold=True), _run("_")]
        else:
            runs = [dict(r) for r in BODY[i % len(BODY)]]
        viewport.append({"row": i, "runs": runs})
    return {"scrollback": scrollback, "viewport": viewport,
            "cursor": {"row": viewport_rows - 1, "col": 2, "visible": True}}


# --- page scripts --------------------------------------------------------------

# Registered before any page script runs, so no violation can be missed.
CSP_LISTENER = """
window.__cspv = [];
document.addEventListener('securitypolicyviolation', e => {
  window.__cspv.push(e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline')
                     + ' @' + (e.sourceFile || '') + ':' + (e.lineNumber || 0));
});
"""

# Fakes auth + one live session (same shape as ipad-emulator.py / w2 ARM).
ARM = """() => {
  localStorage.setItem('cm-hw-keyboard', 'on');
  window.__sent = [];
  queueSend = (o) => { window.__sent.push(o); };
  authScreen.style.display = 'none';
  appEl.classList.add('shown');
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

ROWS = """() => {
  const g = gridTerms[activeSession];
  const d = g ? computeGridDims(g) : null;
  return d ? d.rows : 40;
}"""

# Shared by every screen: device facts, tap targets, control fonts.
SURVEY = """(minTap) => {
  const vis = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
      && r.top < innerHeight && r.left < innerWidth;
  };
  const label = el => '#' + (el.id || '') + '<' + el.tagName.toLowerCase()
    + (el.type ? ':' + el.type : '') + '>'
    + (el.id ? '' : ' "' + (el.getAttribute('aria-label') || el.textContent || '')
       .trim().slice(0, 24) + '"');
  const targets = [...document.querySelectorAll(
    'button, input:not([type=hidden]), textarea, select, a[href], [role=button]')]
    .filter(vis);
  const small = targets.map(el => {
      const r = el.getBoundingClientRect();
      return { el: label(el), w: Math.round(r.width), h: Math.round(r.height) };
    }).filter(t => t.w < minTap || t.h < minTap);
  const fonts = {};
  for (const el of document.querySelectorAll('button, input, textarea')) {
    fonts[label(el)] = { family: getComputedStyle(el).fontFamily, visible: vis(el) };
  }
  return {
    device: {
      viewport: { w: innerWidth, h: innerHeight },
      dpr: devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      touchEventsSupported: 'ontouchstart' in window,
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
      tapsArriveAs: navigator.maxTouchPoints > 0 ? 'touch' : 'mouse',
    },
    tapTargets: { visible: targets.length, under44: small.length, small: small },
    controlFonts: fonts,
  };
}"""

AUTH_TEXT = """() => {
  const el = document.getElementById('auth-screen');
  return el ? el.innerText.split('\\n').map(s => s.trim()).filter(Boolean) : [];
}"""

TERMINAL = """() => {
  const wrap = document.querySelector('.term-wrap.active')
            || document.querySelector('.term-wrap')
            || document.getElementById('term-area');
  const r = wrap ? wrap.getBoundingClientRect() : null;
  const bars = {};
  for (const id of ['header', 'tabs', 'tab-switcher', 'qbar', 'input-wrap', 'input-bar']) {
    const el = document.getElementById(id);
    const shown = el && getComputedStyle(el).display !== 'none';
    const b = shown ? el.getBoundingClientRect() : null;
    bars[id] = b ? { w: Math.round(b.width), h: Math.round(b.height) } : 'hidden';
  }
  const area = r ? Math.round(r.width * r.height) : 0;
  return {
    terminal: r ? { w: Math.round(r.width), h: Math.round(r.height),
                    top: Math.round(r.top), left: Math.round(r.left),
                    areaPx: area,
                    areaPctOfViewport: +(area / (innerWidth * innerHeight) * 100).toFixed(1),
                    heightPct: +(r.height / innerHeight * 100).toFixed(1) } : null,
    bars: bars,
    layout: getComputedStyle(document.getElementById('app')).display,
  };
}"""


def flatten(d, prefix=""):
    out = {}
    if isinstance(d, dict):
        for k, v in d.items():
            out.update(flatten(v, "%s.%s" % (prefix, k) if prefix else k))
    elif isinstance(d, list):
        out[prefix] = json.dumps(d, sort_keys=True)
    else:
        out[prefix] = d
    return out


def print_deltas(current):
    path = os.path.join(BASELINE, "metrics.json")
    if not os.path.exists(path):
        print("\nbaseline: none at %s (run with --baseline to create)" % path)
        return
    base = flatten(json.load(open(path, encoding="utf-8")))
    cur = flatten(current)
    keys = sorted(set(base) | set(cur))
    changed = [(k, base.get(k, "<absent>"), cur.get(k, "<absent>"))
               for k in keys if base.get(k, "<absent>") != cur.get(k, "<absent>")]
    print("\nbaseline deltas (%d; informational, never a failure):" % len(changed))
    for k, b, c in changed:
        b, c = str(b), str(c)
        if len(b) > 70 or len(c) > 70:
            print("  %s: changed" % k)
        else:
            print("  %s: %s -> %s" % (k, b, c))


def main():
    args = sys.argv[1:]
    out = args[args.index("--out") + 1] if "--out" in args else DEFAULT_OUT
    write_baseline = "--baseline" in args
    self_test = "--self-test" in args
    os.makedirs(out, exist_ok=True)

    port = free_port()
    srv = subprocess.Popen(
        ["node", os.path.join(HERE, "static-server.js"), PUBLIC, str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_port(port):
        print("HARNESS BROKEN: static server did not start")
        srv.kill()
        return 2
    base = "http://127.0.0.1:%d" % port
    print("serving %s on %s (webkit)\n" % (PUBLIC, base))

    findings = []          # (profile, kind, text) -- any entry fails the run
    metrics = {"note": "static tier; synthetic session; WebKit on Windows",
                "benignConsoleAllowlist": sorted(BENIGN_CONSOLE)}
    pngs = []
    served = None

    try:
        with sync_playwright() as p:
            browser = p.webkit.launch()
            for idx, (slug, device) in enumerate(PROFILES):
                ctx = browser.new_context(**p.devices[device])
                ctx.add_init_script(CSP_LISTENER)
                page = ctx.new_page()
                console = []
                page.on("console", lambda m, c=console: c.append((m.type, m.text)))
                page.on("pageerror", lambda e, s=slug: findings.append((s, "pageerror", str(e))))
                page.on("dialog", lambda d: d.accept())

                resp = page.goto(base + "/", wait_until="load")
                served = resp.headers.get("content-security-policy") if resp else None
                entry = {"device": device}

                # -- auth ------------------------------------------------------
                page.wait_for_function(
                    "() => getComputedStyle(document.getElementById('totp-section')).display"
                    " !== 'none' || getComputedStyle(document.getElementById('setup-msg'))"
                    ".display !== 'none'", timeout=10000)
                page.wait_for_timeout(300)
                auth = page.evaluate(SURVEY, MIN_TAP)
                auth["visibleText"] = page.evaluate(AUTH_TEXT)
                shot = "%s-auth.png" % slug
                page.screenshot(path=os.path.join(out, shot))
                pngs.append(shot)
                entry["device_facts"] = auth.pop("device")
                entry["auth"] = auth

                if self_test and idx == 0:
                    # One fault of each gated kind. The inline script must be
                    # refused by script-src 'self' (a CSP violation); the other
                    # two are raised directly.
                    page.evaluate("""(mark) => {
                      const s = document.createElement('script');
                      s.textContent = 'window.__selfTestRan = true';
                      document.head.appendChild(s);
                      console.error(mark + ': console.error');
                      setTimeout(() => { throw new Error(mark + ': pageerror'); }, 0);
                    }""", SELF_TEST_MARK)
                    page.wait_for_timeout(300)

                # -- app shell ---------------------------------------------------
                page.evaluate(ARM)
                page.wait_for_timeout(300)
                page.evaluate("(s) => { applyGridSnapshot(gridTerms[activeSession], s); }",
                              build_snapshot(max(10, page.evaluate(ROWS))))
                page.wait_for_timeout(500)
                app = page.evaluate(SURVEY, MIN_TAP)
                app.pop("device")
                app.update(page.evaluate(TERMINAL))
                shot = "%s-app.png" % slug
                page.screenshot(path=os.path.join(out, shot))
                pngs.append(shot)
                entry["app"] = app

                # -- settings (opened by a click: mouse on Windows WebKit) -------
                page.click("#settings-btn")
                page.wait_for_timeout(400)
                opened = page.evaluate("() => settingsOpen()")
                if not opened:
                    findings.append((slug, "settings", "settings panel did not open on click"))
                st = page.evaluate(SURVEY, MIN_TAP)
                st.pop("device")
                st["opened"] = opened
                shot = "%s-settings.png" % slug
                page.screenshot(path=os.path.join(out, shot))
                pngs.append(shot)
                entry["settings"] = st

                # -- gate ----------------------------------------------------------
                for v in page.evaluate("() => window.__cspv"):
                    findings.append((slug, "csp-violation", v))
                allowed = []
                for typ, text in console:
                    if typ != "error":
                        continue
                    if text in BENIGN_CONSOLE:
                        allowed.append(text)
                    else:
                        findings.append((slug, "console-error", text))
                entry["consoleErrorsAllowlisted"] = allowed
                # Everything else WebKit said, for the record (never gated).
                entry["consoleOther"] = sorted({"%s: %s" % (t, x) for t, x in console
                                                if t != "error"})
                if self_test and idx == 0:
                    entry["selfTestInlineScriptRan"] = bool(
                        page.evaluate("() => window.__selfTestRan === true"))

                metrics[slug] = entry
                ctx.close()

                a, t = entry["app"], entry["app"]["terminal"] or {}
                df = entry["device_facts"]
                print("%-22s %sx%s dpr=%s maxTouchPoints=%s (taps as %s)"
                      % (slug, df["viewport"]["w"], df["viewport"]["h"], df["dpr"],
                         df["maxTouchPoints"], df["tapsArriveAs"]))
                print("   terminal  %sx%s px = %s%% of viewport area (%s%% of height)"
                      % (t.get("w"), t.get("h"), t.get("areaPctOfViewport"), t.get("heightPct")))
                print("   bars      %s" % a["bars"])
                print("   <44px     auth %d/%d   app %d/%d   settings %d/%d"
                      % (entry["auth"]["tapTargets"]["under44"], entry["auth"]["tapTargets"]["visible"],
                         a["tapTargets"]["under44"], a["tapTargets"]["visible"],
                         st["tapTargets"]["under44"], st["tapTargets"]["visible"]))
                print()
            browser.close()
    finally:
        srv.kill()

    # CSP parity with production (D10): the served header must equal server.js.
    prod = server_js_csp()
    metrics["cspParity"] = {"served": served, "serverJs": prod, "match": served == prod}
    if served != prod:
        findings.append(("all", "csp-parity",
                         "static-server CSP != server.js\n  served: %s\n  prod:   %s"
                         % (served, prod)))

    # Font families across every screen, summarised.
    fams = {}
    for slug, _ in PROFILES:
        for screen in ("auth", "app", "settings"):
            for el, f in metrics[slug][screen]["controlFonts"].items():
                if f["visible"]:
                    fams.setdefault(f["family"], set()).add(el)
    print("control font-family (visible buttons/inputs/textareas, all profiles):")
    for fam, els in sorted(fams.items()):
        print("   %-60s %s" % (fam, ", ".join(sorted(els))))
    print("\nauth screen text (%s): %s"
          % (PROFILES[0][0], " | ".join(metrics[PROFILES[0][0]]["auth"]["visibleText"])))

    with open(os.path.join(out, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2, sort_keys=True)
    print("\nPNGs + metrics.json -> %s" % out)

    if write_baseline and not self_test:
        os.makedirs(BASELINE, exist_ok=True)
        for name in pngs + ["metrics.json"]:
            shutil.copyfile(os.path.join(out, name), os.path.join(BASELINE, name))
        print("baseline written -> %s" % BASELINE)
    else:
        print_deltas(metrics)

    print()
    if findings:
        print("GATE FAILED (%d):" % len(findings))
        for s, kind, text in findings:
            print("  [%s] %s: %s" % (s, kind, text))
    else:
        print("GATE PASSED: no console errors, page errors or CSP violations; CSP matches server.js")

    if self_test:
        kinds = {k for _, k, t in findings
                 if SELF_TEST_MARK in t or (k == "csp-violation" and "script-src" in t)}
        want = {"csp-violation", "console-error", "pageerror"}
        missed = want - kinds
        if missed:
            print("SELF-TEST BROKEN: gate did not catch %s" % sorted(missed))
            return 2
        print("SELF-TEST OK: gate caught all injected faults %s -> exit 1" % sorted(want))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
