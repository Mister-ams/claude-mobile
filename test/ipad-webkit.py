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
server.js. T05 adds the terminal palette: every ANSI colour (and the
default fg) must be >= 4.5:1 (WCAG AA) on the terminal background read from
the running client, the xterm theme must equal termPalette() (one source),
and the grid must be opaque on that background and monospace. T11 adds cell
geometry: clicks inside laid-out glyphs must resolve (gridCellFromEvent) to
that exact cell and the cursor must sit on its cell, before and after a
font-size change. T07 adds the side pane: one row per session with state,
name, cwd, worktree and title; priority order; the sort control (reused rows,
persisted); a server broadcast applied as a keyed diff (MutationObserver: no
row rebuilt, only the changed row written, one move); every pane target
>= 44px; portrait slide-over opened by the toolbar button, closed by the scrim
and by a pick (<profile>-sidepane-open.png); and terminal area >= the pinned
pre-T07 floor. T08 adds the keyboard layer, driven by real key presses:
ctrl+b then n/p/2/a/a/s/?/v/ctrl+b (the web keys switch sessions in side-pane
order, a jumps blocked-then-done, v leaves as the exact bytes \x02v, ctrl+b
ctrl+b as one \x02), the prefix timing out so the next key is plain again,
plain keys (a, ctrl+c, Esc, arrows, alt) reaching the terminal byte for byte,
the ? list filtering, the Cmd-K switcher filtering by name/cwd/title and
picking with arrows + Enter, focus trapped in both and handed back on close,
>= 44px targets (<profile>-help.png, <profile>-switcher.png), and focus
reports (CSI ?1004h) sent in/out on window focus, blur and session switch
only while the mode is on. The only tolerated console error is listed by EXACT text in
BENIGN_CONSOLE below -- never add a pattern there, and never add a message
that describes a real defect.

BASELINE: --baseline copies the PNGs + metrics into test/baseline/ipad-webkit/
(committed). The default run compares metrics to that baseline and PRINTS the
deltas; deltas never fail the run, because later tasks change the UI on
purpose.

SELF-TEST: --self-test injects one fault of each gated kind (an inline script
the CSP must refuse, a console.error, an uncaught exception, a stock-yellow
ANSI 3 below AA, a cell model 10% off the laid-out glyphs) into the first
profile, plus (T08) a prefix passthrough that drops the \x02. Expected exit:
1 with all of them caught. Exit 2 means the gate missed
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

# Fakes auth + a live session list (same shape as ipad-emulator.py / w2 ARM).
ARM = """(sessions) => {
  localStorage.setItem('cm-hw-keyboard', 'on');
  window.__sent = [];
  queueSend = (o) => { window.__sent.push(o); };
  authScreen.style.display = 'none';
  appEl.classList.add('shown');
  ws = { readyState: 1, send() {} };
  sessionList = sessions;
  activeSession = null;
  switchTo(1);
  applyHwKeyboard();
  return true;
}"""

# T07: the session list as server.js broadcasts it on herdr -- each session
# carries T06's `agent` view -- with one session in each state the side pane
# draws, listed in an order that is NOT the priority order (so a sort that did
# nothing would fail). Session 1 is the active one.
def _agent(status, cwd, title, worktree=None):
    return {"status": status, "herdrStatus": "idle" if status == "done" else status,
            "seen": status != "done", "agent": "claude", "title": title, "cwd": cwd,
            "worktree": worktree, "agentSessionId": None, "paneId": "p1", "seq": 1,
            "feed": "events", "reconnects": 0}


SESSIONS = [
    {"id": 1, "name": "LOOMI OS", "dir": "/mnt/c/Users/MRAL-/Projects/loomi-os", "attention": None,
     "viewers": 1, "agent": _agent("idle", "C:\\Users\\MRAL-\\Projects\\loomi-os", "Claude Code",
                                   {"repo": "loomi-os", "root": None, "path": None, "linked": False})},
    {"id": 2, "name": "CLAUDE-MOBILE", "dir": "/mnt/c/Users/MRAL-/Projects/claude-mobile", "attention": None,
     "viewers": 0, "agent": _agent("working", "C:\\Users\\MRAL-\\Projects\\_wt\\cm-next",
                                   "Claude Code - side pane",
                                   {"repo": "claude-mobile", "root": None,
                                    "path": "C:\\Users\\MRAL-\\Projects\\_wt\\cm-next", "linked": True})},
    {"id": 3, "name": "HERDR", "dir": "/root/work", "attention": "permission",
     "viewers": 0, "agent": _agent("blocked", "C:\\root\\work", "Claude Code")},
    {"id": 4, "name": "LOOMI API", "dir": "/mnt/c/Users/MRAL-/Projects/loomi-api", "attention": "ready",
     "viewers": 0, "agent": _agent("done", "C:\\Users\\MRAL-\\Projects\\loomi-api", "Claude Code")},
]
SP_RANK = {"blocked": 0, "done": 1, "working": 2, "idle": 3, "unknown": 4}


def priority_order(sessions):
    """The oracle: blocked, done, working, idle, unknown; stable by list order."""
    return [s["id"] for _, s in sorted(enumerate(sessions),
                                       key=lambda p: (SP_RANK[p[1]["agent"]["status"]], p[0]))]


# What the server sends after the operator views session 4 (D7: the finish is
# no longer news). Same ids, fresh objects -- as every broadcast is.
def viewed_update(sessions, sid):
    out = json.loads(json.dumps(sessions))
    for s in out:
        if s["id"] == sid:
            s["agent"]["status"], s["agent"]["seen"], s["attention"] = "idle", True, None
    return out


# T07: terminal area (px^2) BEFORE the side pane, from the committed T01-T11
# baseline. Pinned here, not read from the baseline file, so re-baselining can
# never lower the bar. The pane may only give the terminal room, never take it.
TERMINAL_FLOOR = {
    "ipad-pro-11": 841969,            # 814x1034 (portrait: tab strip at the bottom)
    "ipad-pro-11-landscape": 788676,  # 984x802  (landscape: 190px rail)
    "ipad-gen-11": 483050,            # phone layout, unchanged by T07
    "ipad-gen-11-landscape": 457729,
}

# T07: the side pane as the page shows it. Visibility is computed, never
# assumed from a class: a closed portrait sheet is transformed off-screen.
SP_STATE = """() => {
  const vis = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth
      && r.bottom > 0 && r.top < innerHeight;
  };
  const pane = document.getElementById('sidepane');
  const pr = pane.getBoundingClientRect();
  const q = (li, sel) => li.querySelector(sel);
  const rows = [...document.querySelectorAll('#sp-list > .sp-row')].map(li => ({
    id: +li.dataset.id, status: li.dataset.status,
    glyph: q(li, '.sp-state use').getAttribute('href'),
    name: q(li, '.sp-name').textContent, cwd: q(li, '.sp-cwd').textContent,
    worktree: q(li, '.sp-wt').hidden ? null : q(li, '.sp-wt').textContent,
    title: q(li, '.sp-title').textContent,
    current: q(li, '.sp-main').getAttribute('aria-current'),
    label: q(li, '.sp-main').getAttribute('aria-label'),
    closeLabel: q(li, '.sp-close').getAttribute('aria-label'),
    unseenShown: getComputedStyle(q(li, '.sp-unseen')).display !== 'none',
  }));
  const targets = [...document.querySelectorAll(
      '#sidepane button, #sidepane [role=button], #sp-toggle, #new-btn, #settings-btn')]
    .filter(vis).map(el => {
      const r = el.getBoundingClientRect();
      return { el: el.id || el.className, label: el.getAttribute('aria-label'),
               w: Math.round(r.width), h: Math.round(r.height) };
    });
  const wrap = document.querySelector('.term-wrap.active');
  const tr = wrap ? wrap.getBoundingClientRect() : null;
  return {
    visible: vis(pane), open: pane.classList.contains('open'),
    rect: { left: Math.round(pr.left), right: Math.round(pr.right), top: Math.round(pr.top),
            bottom: Math.round(pr.bottom), w: Math.round(pr.width) },
    toggleVisible: vis(document.getElementById('sp-toggle')),
    toggleExpanded: document.getElementById('sp-toggle').getAttribute('aria-expanded'),
    scrimOpen: document.getElementById('sp-scrim').classList.contains('open'),
    pillVisible: vis(document.getElementById('tab-pill')),
    active: activeSession,
    order: rows.map(r => r.id),
    rows, targets,
    terminalLeft: tr ? Math.round(tr.left) : null,
    sort: document.getElementById('sp-sort-val').textContent,
    sortStored: (() => { try { return localStorage.getItem('cm-sidepane-sort'); } catch (e) { return 'n/a'; } })(),
  };
}"""

# T07: rows update by keyed diff. Feeds one server broadcast through the real
# message handler while a MutationObserver watches the list, then reports
# whether every row node survived, how many were moved or created, and which
# rows had anything inside them written at all.
SP_DIFF = """(update) => {
  const list = document.getElementById('sp-list');
  const before = new Map([...list.children].map(li => [li.dataset.id, li]));
  const recs = [];
  const mo = new MutationObserver(ms => recs.push(...ms));
  mo.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });
  if (update) handle({ type: 'sessions', sessions: update });
  else document.getElementById('sp-sort').click();
  recs.push(...mo.takeRecords());
  mo.disconnect();
  const after = [...list.children];
  const added = new Set();
  for (const r of recs) if (r.target === list) r.addedNodes.forEach(n => added.add(n));
  const touched = new Set();
  for (const r of recs) {
    if (r.target === list) continue;
    const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    const li = el && el.closest('.sp-row');
    if (li) touched.add(li.dataset.id);
  }
  return {
    reused: after.length === before.size && after.every(li => before.get(li.dataset.id) === li),
    order: after.map(li => +li.dataset.id),
    moved: [...added].filter(n => n.dataset && before.get(n.dataset.id) === n).length,
    created: [...added].filter(n => !(n.dataset && before.get(n.dataset.id) === n)).length,
    touched: [...touched].map(Number).sort(),
    status: Object.fromEntries(after.map(li => [li.dataset.id, li.dataset.status])),
  };
}"""


def settle(page, want_open):
    """Wait for the portrait sheet's END state (slide finished, visibility
    flipped) rather than a fixed time; the checks after it report failures."""
    try:
        page.wait_for_function(
            "(o) => getComputedStyle(sidepane).visibility === (o ? 'visible' : 'hidden')"
            " && (!o || getComputedStyle(sidepane).transform === 'none')", arg=want_open, timeout=4000)
    except Exception:
        pass
    page.wait_for_timeout(100)


def check_sidepane(page, slug, out, pngs, findings, self_test):
    """T07 gate. Returns the metrics record."""
    rec = {}
    wide = page.evaluate("() => isWideLayout()")
    modal = page.evaluate("() => sidepaneIsModal()")
    st = page.evaluate(SP_STATE)
    rec["closed"] = st
    if not wide:
        # Phone layout: no pane, the tab pill keeps its job.
        if st["visible"] or not st["pillVisible"]:
            findings.append((slug, "sidepane", "phone layout: pane visible=%s, tab pill visible=%s"
                             % (st["visible"], st["pillVisible"])))
        rec["mode"] = "phone"
        return rec
    rec["mode"] = "slide-over" if modal else "pinned"

    def fail(text):
        findings.append((slug, "sidepane", text))

    if modal:
        if st["visible"] or st["open"] or not st["toggleVisible"]:
            fail("portrait: pane should start closed with the toggle shown (visible=%s open=%s toggle=%s)"
                 % (st["visible"], st["open"], st["toggleVisible"]))
        page.click("#sp-toggle")
        settle(page, True)
        st = page.evaluate(SP_STATE)
        rec["open"] = st
        if not (st["visible"] and st["open"] and st["scrimOpen"] and st["rect"]["left"] >= 0
                and st["toggleExpanded"] == "true"):
            fail("portrait: toggle did not open the sheet: %s" % {k: st[k] for k in
                 ("visible", "open", "scrimOpen", "rect", "toggleExpanded")})
        shot = "%s-sidepane-open.png" % slug
        page.screenshot(path=os.path.join(out, shot))
        pngs.append(shot)
    else:
        if not st["visible"]:
            fail("landscape: pane not pinned on screen")
        elif st["terminalLeft"] is None or st["rect"]["right"] > st["terminalLeft"]:
            fail("landscape: pane (right %s) covers the terminal (left %s)"
                 % (st["rect"]["right"], st["terminalLeft"]))

    # -- rows: one per session, fields, priority order ---------------------------
    want = priority_order(SESSIONS)
    if len(st["rows"]) != len(SESSIONS):
        fail("%d rows for %d sessions" % (len(st["rows"]), len(SESSIONS)))
    if st["order"] != want:
        fail("row order %s != priority order %s" % (st["order"], want))
    by_id = {s["id"]: s for s in SESSIONS}
    for r in st["rows"]:
        s = by_id.get(r["id"])
        if not s:
            continue
        a = s["agent"]
        cwd = re.split(r"[\\/]+", a["cwd"].rstrip("\\/"))[-1]
        wt = a["worktree"]
        # First of (linked checkout name, repo name) that the cwd does not say.
        cands = ([re.split(r"[\\/]+", wt["path"])[-1] if wt["linked"] and wt["path"] else None,
                  wt["repo"]] if wt else [])
        want_wt = next((c for c in cands if c and c != cwd), None)
        bad = []
        if r["status"] != a["status"] or r["glyph"] != "#s-" + a["status"]:
            bad.append("status %s/%s" % (r["status"], r["glyph"]))
        if r["name"] != s["name"]:
            bad.append("name %r" % r["name"])
        if r["cwd"] != cwd:
            bad.append("cwd %r != %r" % (r["cwd"], cwd))
        if r["worktree"] != want_wt:
            bad.append("worktree %r != %r" % (r["worktree"], want_wt))
        if r["title"] != a["title"]:
            bad.append("title %r" % r["title"])
        if (r["current"] == "true") != (s["id"] == st["active"]):
            bad.append("aria-current %r" % r["current"])
        if r["unseenShown"] != (a["status"] == "done"):
            bad.append("unseen dot %s" % r["unseenShown"])
        if not r["label"] or s["name"] not in r["label"] or not r["closeLabel"]:
            bad.append("labels %r / %r" % (r["label"], r["closeLabel"]))
        if bad:
            fail("row %s: %s" % (s["id"], "; ".join(bad)))

    # -- targets >= 44 CSS px -----------------------------------------------------
    small = [t for t in st["targets"] if t["w"] < MIN_TAP or t["h"] < MIN_TAP]
    rec["targets"] = {"visible": len(st["targets"]), "under44": small}
    if not st["targets"]:
        fail("no side-pane targets visible to measure")
    for t in small:
        fail("target under %dpx: %s" % (MIN_TAP, t))

    # -- sort control: Manual then back to Priority, rows reused, persisted -------
    d = page.evaluate(SP_DIFF, None)
    stored = page.evaluate("() => localStorage.getItem('cm-sidepane-sort')")
    manual_want = [s["id"] for s in SESSIONS]
    if d["order"] != manual_want or not d["reused"] or d["created"] or stored != "manual":
        fail("sort -> manual: order %s (want %s) reused=%s created=%s stored=%r"
             % (d["order"], manual_want, d["reused"], d["created"], stored))
    d2 = page.evaluate(SP_DIFF, None)
    stored = page.evaluate("() => localStorage.getItem('cm-sidepane-sort')")
    if d2["order"] != want or not d2["reused"] or stored != "priority":
        fail("sort -> priority: order %s reused=%s stored=%r" % (d2["order"], d2["reused"], stored))
    rec["sortToggle"] = {"manual": d, "priority": d2}

    # -- pick a row: done session 4 is viewed -> connect sent, sheet closes -------
    if modal:
        page.mouse.click(page.viewport_size["width"] - 30, page.viewport_size["height"] // 2)
        settle(page, False)
        st = page.evaluate(SP_STATE)
        rec["afterScrim"] = {"open": st["open"], "visible": st["visible"]}
        if st["open"] or st["visible"]:
            fail("portrait: tapping the scrim did not close the sheet")
        page.click("#sp-toggle")
        settle(page, True)
    page.evaluate("() => { window.__sent = []; }")
    page.click('#sp-list .sp-row[data-id="4"] .sp-main')
    # Mounting the picked session blocks the main thread for a few hundred ms
    # in headless WebKit on Windows, which (no threaded compositor here) also
    # holds the slide-out; wait for the end state instead of a fixed time.
    try:
        page.wait_for_function("() => activeSession === 4 && (!sidepaneIsModal()"
                               " || getComputedStyle(sidepane).visibility === 'hidden')",
                               timeout=4000)
    except Exception:
        pass  # the checks below report what state it stopped in
    st = page.evaluate(SP_STATE)
    sent = page.evaluate("() => window.__sent")
    rec["afterPick"] = {"active": st["active"], "open": st["open"], "visible": st["visible"],
                        "connectSent": [m for m in sent if m.get("type") == "connect"]}
    if st["active"] != 4 or not any(m.get("type") == "connect" and m.get("session") == 4 for m in sent):
        fail("picking row 4 did not switch + connect (active=%s sent=%s)" % (st["active"], sent))
    if modal and (st["open"] or st["visible"]):
        fail("portrait: picking a session did not close the sheet")

    # -- done clears on view: the server's follow-up broadcast, diffed ----------
    if self_test and slug == PROFILES[0][0]:
        # An innerHTML rebuild must fail the reuse check.
        page.evaluate("""() => { const real = renderSidepane;
          renderSidepane = function () { spList.innerHTML = ''; spRows.clear(); real(); }; }""")
    d3 = page.evaluate(SP_DIFF, viewed_update(SESSIONS, 4))
    rec["viewedUpdate"] = d3
    want3 = priority_order(viewed_update(SESSIONS, 4))
    if not d3["reused"] or d3["created"]:
        fail("broadcast rebuilt rows (reused=%s created=%d) -- not a keyed diff"
             % (d3["reused"], d3["created"]))
    if d3["order"] != want3 or d3["status"].get("4") != "idle":
        fail("after view: order %s (want %s), row 4 %s" % (d3["order"], want3, d3["status"].get("4")))
    if d3["moved"] > 1 or d3["touched"] != [4]:
        fail("after view: %d rows moved (want 1), rows written %s (want [4])" % (d3["moved"], d3["touched"]))
    return rec


# -- T08: keyboard layer --------------------------------------------------------
# Every check drives REAL key presses through the page (Playwright keyboard ->
# the client's own keydown listeners) and reads what the ARM's queueSend stub
# captured, so "reaches the terminal" means the exact bytes the server would
# have been sent.
KB_STATE = """() => {
  const vis = el => !!el && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none'
    && el.getBoundingClientRect().width > 0;
  const box = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const ov = id => {
    const el = document.getElementById(id);
    const dlg = el.querySelector('[role=dialog]');
    return { open: !el.hidden, dialog: !!dlg && dlg.getAttribute('aria-modal') === 'true',
             focusInside: el.contains(document.activeElement),
             targets: [...el.querySelectorAll('button, input, [role=option]')].filter(vis)
               .map(x => Object.assign({ el: x.id || x.className }, box(x))) };
  };
  const ae = document.activeElement;
  return {
    active: activeSession, armed: kbPrefixArmed,
    chip: vis(document.getElementById('kb-chip')) ? document.getElementById('kb-chip').textContent : null,
    sidepaneOpen: sidepaneOpen(), modal: sidepaneIsModal(),
    terminalKeys: terminalHasKeyboardFocus(),
    focused: ae ? (ae.id || ae.tagName.toLowerCase()) : null,
    switcher: ov('kb-switcher'), help: ov('kb-help'),
    options: [...document.querySelectorAll('#ksw-list [role=option]')].map(li => +li.dataset.id),
    selected: [...document.querySelectorAll('#ksw-list [role=option][aria-selected=true]')].map(li => +li.dataset.id),
    helpRows: [...document.querySelectorAll('#khelp-list .kb-row')].filter(vis).map(li => li.textContent),
    helpTotal: document.querySelectorAll('#khelp-list .kb-row').length,
    sent: window.__sent.filter(m => m.type === 'input').map(m => m.data),
  };
}"""

KB_RESET = """(sessions) => {
  if (kbOverlayOpen()) kbCloseOverlay();
  closeSettings(); closeSidepane(); kbDisarmPrefix(); kbChipHide();
  handle({ type: 'sessions', sessions });
  if (activeSession !== 1) switchTo(1);
  const ae = document.activeElement;
  if (ae && ae !== document.body) ae.blur();
  window.__sent = [];
  return activeSession;
}"""

# Focus reporting, driven through the real message handler (mouse-mode is how
# the server tells the client the pane asked for CSI ?1004h) and real window
# focus/blur events.
FOCUS_REPORT = """() => {
  const got = () => { const f = window.__sent.filter(m => m.type === 'focus')
    .map(m => [m.session, m.focused]); window.__sent = []; return f; };
  const sid = activeSession;
  const other = sessionList.find(s => s.id !== sid).id;
  const mode = on => handle({ type: 'mouse-mode', session: sid,
    mouse: { tracking: 'any', encoding: 'sgr', focus: on } });
  const out = { sid };
  window.__sent = [];
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));
  out.modeOff = got();
  mode(true);                                   out.modeOn = got();
  window.dispatchEvent(new Event('blur'));      out.blur = got();
  window.dispatchEvent(new Event('focus'));     out.focus = got();
  selectSession(other);                         out.switchAway = got();
  selectSession(sid);                           out.switchBack = got();
  mode(false);                                  out.modeOffAgain = got();
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));     out.afterOff = got();
  return out;
}"""


def check_shortcuts(page, slug, out, pngs, findings, self_test):
    """T08 gate. Returns the metrics record."""
    rec = {}

    def fail(text):
        findings.append((slug, "shortcuts", text))

    def st():
        return page.evaluate(KB_STATE)

    def clear():
        page.evaluate("() => { window.__sent = []; }")

    def keys(*ks):
        for k in ks:
            page.keyboard.press(k)
        page.wait_for_timeout(60)   # the 4ms printable coalescing tick

    page.evaluate(KB_RESET, SESSIONS)
    page.wait_for_timeout(150)
    order = priority_order(SESSIONS)   # [3, 4, 2, 1]: blocked, done, working, idle
    status = dict((x["id"], x["agent"]["status"]) for x in SESSIONS)

    # 1. no prefix: plain keys reach the terminal byte for byte. Compared as
    #    one stream: a printable may share a write with the key after it (T12's
    #    atomic flush), which is the same bytes in the same order.
    keys("a", "Control+c", "Escape", "ArrowUp", "Alt+x")
    s = st()
    want = "a\x03\x1b\x1b[A\x1bx"
    rec["plainKeys"] = "".join(s["sent"])
    if "".join(s["sent"]) != want:
        fail("plain keys sent %r, want %r" % (s["sent"], want))

    # 2. ctrl+b arms (chip shown, nothing sent); n/p/2/a switch sessions
    clear()
    page.keyboard.press("Control+b")
    s = st()
    rec["chip"] = s["chip"]
    if not s["armed"] or not s["chip"] or s["sent"]:
        fail("ctrl+b: armed=%s chip=%r sent=%r" % (s["armed"], s["chip"], s["sent"]))
    steps = []

    def after(label, want_active):
        page.wait_for_timeout(80)
        s = st()
        steps.append((label, s["active"]))
        if s["active"] != want_active or s["sent"] or s["armed"]:
            fail("ctrl+b %s: active %s (want %s), sent %r, still armed=%s"
                 % (label, s["active"], want_active, s["sent"], s["armed"]))

    page.keyboard.press("n")
    after("n", order[(order.index(1) + 1) % len(order)])
    for key, want_active in (("p", 1), ("2", order[1])):
        clear()
        keys("Control+b", key)
        after(key, want_active)
    # a: blocked first, then the unseen finish, cycling from the active one
    queue = [i for i in order if status[i] in ("blocked", "done")]
    cur = order[1]
    for n in range(2):
        nxt = queue[(queue.index(cur) + 1) % len(queue)] if cur in queue else queue[0]
        clear()
        keys("Control+b", "a")
        after("a#%d" % (n + 1), nxt)
        cur = nxt
    rec["switches"] = steps

    # 3. s: the portrait sheet opens; elsewhere consumed with a notice
    clear()
    keys("Control+b", "s")
    s = st()
    rec["s"] = {"modal": s["modal"], "opened": s["sidepaneOpen"], "chip": s["chip"]}
    if s["sent"]:
        fail("ctrl+b s sent %r" % s["sent"])
    if s["modal"]:
        if not s["sidepaneOpen"]:
            fail("ctrl+b s did not open the portrait sheet")
        keys("Escape")
        s2 = st()
        if s2["sidepaneOpen"] or not s2["terminalKeys"]:
            fail("Esc after ctrl+b s: open=%s terminal keys=%s" % (s2["sidepaneOpen"], s2["terminalKeys"]))
        page.wait_for_timeout(300)
    elif s["sidepaneOpen"] or not s["chip"]:
        fail("ctrl+b s (not portrait): open=%s chip=%r" % (s["sidepaneOpen"], s["chip"]))

    # 4. passthrough: any other key leaves as ctrl+b + key, in one write
    fault = self_test and slug == PROFILES[0][0]
    if fault:
        page.evaluate("() => { window.__realPass = kbPrefixPassthrough;"
                      " kbPrefixPassthrough = (seq) => kbFlush(seq); }")
    clear()
    keys("Control+b", "v")
    s = st()
    rec["passthroughV"] = s["sent"]
    if s["sent"] != ["\x02v"]:
        fail("prefix passthrough: ctrl+b v sent %r, want ['\\x02v']" % s["sent"])
    if fault:
        page.evaluate("() => { kbPrefixPassthrough = window.__realPass; }")
    clear()
    keys("Control+b", "Control+b")
    s = st()
    rec["literalPrefix"] = s["sent"]
    if s["sent"] != ["\x02"] or s["armed"]:
        fail("ctrl+b ctrl+b sent %r (want ['\\x02']), armed=%s" % (s["sent"], s["armed"]))
    clear()
    keys("Control+b", "Shift+Minus")   # shifted punctuation passes through too
    s = st()
    if s["sent"] != ["\x02_"]:
        fail("ctrl+b _ sent %r, want ['\\x02_']" % s["sent"])

    # 5. timeout: the prefix lapses, sends nothing, the next key is plain
    clear()
    page.keyboard.press("Control+b")
    page.wait_for_timeout(1800)
    s = st()
    if s["armed"] or s["chip"] or s["sent"]:
        fail("prefix did not lapse cleanly: armed=%s chip=%r sent=%r" % (s["armed"], s["chip"], s["sent"]))
    keys("x")
    s = st()
    rec["afterTimeout"] = s["sent"]
    if s["sent"] != ["x"]:
        fail("key after the prefix lapsed sent %r, want ['x']" % s["sent"])

    # 6. ctrl+b ? : the key list, filterable, focus trapped, Esc restores
    clear()
    keys("Control+b", "Shift+Slash")
    page.wait_for_timeout(250)
    s = st()
    h = s["help"]
    if not (h["open"] and h["dialog"] and s["focused"] == "khelp-input"):
        fail("ctrl+b ?: open=%s dialog=%s focus=%s" % (h["open"], h["dialog"], s["focused"]))
    shot = "%s-help.png" % slug
    page.screenshot(path=os.path.join(out, shot))
    pngs.append(shot)
    total = s["helpTotal"]
    page.keyboard.type("split")
    page.wait_for_timeout(80)
    s = st()
    rows = s["helpRows"]
    rec["help"] = {"total": total, "filtered": rows}
    if not rows or len(rows) >= total or any("split" not in r.lower() for r in rows):
        fail("? filter 'split': %d of %d rows %r" % (len(rows), total, rows))
    for _ in range(3):
        page.keyboard.press("Tab")
    s = st()
    if not s["help"]["focusInside"]:
        fail("? overlay: Tab let focus escape to %s" % s["focused"])
    small = [t for t in s["help"]["targets"] if t["w"] < MIN_TAP or t["h"] < MIN_TAP]
    if small:
        fail("? overlay targets under %dpx: %s" % (MIN_TAP, small))
    keys("Escape")
    s = st()
    if s["help"]["open"] or not s["terminalKeys"] or s["sent"]:
        fail("? overlay Esc: open=%s terminal keys=%s sent=%r (typing leaked?)"
             % (s["help"]["open"], s["terminalKeys"], s["sent"]))

    # 7. Cmd-K: the switcher, filtered by name / cwd / title, picked by Enter
    active0 = st()["active"]
    clear()
    keys("Meta+k")
    page.wait_for_timeout(250)
    s = st()
    w = s["switcher"]
    if not (w["open"] and w["dialog"] and s["focused"] == "ksw-input"):
        fail("Cmd-K: open=%s dialog=%s focus=%s" % (w["open"], w["dialog"], s["focused"]))
    if s["options"] != order:
        fail("switcher options %s != side-pane order %s" % (s["options"], order))
    first = next((i for i in order if i != active0), None)
    if s["selected"] != [first]:
        fail("switcher preselected %s, want the first non-current %s" % (s["selected"], first))
    shot = "%s-switcher.png" % slug
    page.screenshot(path=os.path.join(out, shot))
    pngs.append(shot)
    small = [t for t in w["targets"] if t["w"] < MIN_TAP or t["h"] < MIN_TAP]
    if small:
        fail("switcher targets under %dpx: %s" % (MIN_TAP, small))
    filters = {}
    for q, want_ids in (("mobile", [2]), ("loomi-api", [4]), ("side pane", [2]), ("zzq", [])):
        page.fill("#ksw-input", q)
        page.wait_for_timeout(50)
        got = st()["options"]
        filters[q] = got
        if got != want_ids:
            fail("switcher filter %r -> %s, want %s" % (q, got, want_ids))
    rec["switcherFilters"] = filters
    page.fill("#ksw-input", "")
    keys("ArrowDown")
    s = st()
    pick = s["selected"][0] if s["selected"] else None
    want_pick = order[(order.index(first) + 1) % len(order)]
    if pick != want_pick:
        fail("ArrowDown selected %s, want %s" % (pick, want_pick))
    for _ in range(3):
        page.keyboard.press("Tab")
    if not st()["switcher"]["focusInside"]:
        fail("switcher: Tab let focus escape")
    page.focus("#ksw-input")
    keys("Enter")
    page.wait_for_timeout(150)
    s = st()
    rec["switcherPick"] = {"picked": pick, "active": s["active"]}
    if s["active"] != pick or s["switcher"]["open"] or not s["terminalKeys"] or s["sent"]:
        fail("switcher Enter: active %s (want %s), open=%s, terminal keys=%s, sent=%r"
             % (s["active"], pick, s["switcher"]["open"], s["terminalKeys"], s["sent"]))
    keys("Meta+k")
    page.wait_for_timeout(150)
    keys("Escape")
    s = st()
    if s["switcher"]["open"] or s["active"] != pick or not s["terminalKeys"]:
        fail("switcher Esc: open=%s active=%s terminal keys=%s"
             % (s["switcher"]["open"], s["active"], s["terminalKeys"]))

    # 8. focus reports: only while the pane asked, in/out on focus/blur/switch
    fr = page.evaluate(FOCUS_REPORT)
    sid = fr["sid"]
    want_fr = {"modeOff": [], "modeOn": [[sid, True]], "blur": [[sid, False]],
               "focus": [[sid, True]], "switchAway": [[sid, False]], "switchBack": [[sid, True]],
               "modeOffAgain": [], "afterOff": []}
    rec["focusReport"] = {k: fr.get(k) for k in want_fr}
    for k, v in want_fr.items():
        if fr.get(k) != v:
            fail("focus report %s: %s, want %s" % (k, fr.get(k), v))
    page.evaluate(KB_RESET, SESSIONS)
    return rec


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


# T05: the terminal palette as the running client resolves it. termPalette()
# is the one source both renderers use; the grid's computed styles and the
# xterm theme are read back to prove they agree with it.
PALETTE = """() => {
  const p = termPalette();
  const t = getTermTheme();
  const g = document.querySelector('.term-wrap.active .grid-term');
  const cs = g ? getComputedStyle(g) : null;
  const area = getComputedStyle(document.getElementById('term-area'));
  return {
    bg: p.bg, fg: p.fg, ansi: p.ansi,
    xtermAnsi: XTERM_ANSI_NAMES.map(n => t[n]),
    xtermBg: t.background, xtermFg: t.foreground,
    gridBg: cs ? cs.backgroundColor : null,
    gridFg: cs ? cs.color : null,
    gridFont: cs ? cs.fontFamily : null,
    areaBg: area.backgroundColor,
  };
}"""

# T11: cell geometry. gridCellFromEvent, the cursor and the row stack all use
# the renderer's cached cell metrics (row index * rowHeight, col * charWidth).
# This checks them against what WebKit actually laid out: for sampled
# characters in fully visible viewport rows, a DOM Range gives the glyph's
# real box; a click at 20%/50%/80% of that box must resolve to that exact
# (col, row), and the cursor's rendered box must sit on its cell. Ground truth
# is the layout, never the model under test.
GEOMETRY = """() => {
  const g = gridTerms[activeSession];
  if (!g) return { error: 'no grid' };
  const wr = g.wrap.getBoundingClientRect();
  const out = { checked: 0, bad: [], cursor: null,
                rowHeight: g.rowHeight, charWidth: g.charWidth };
  const charBox = (rowEl, i) => {
    const w = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
    let n, k = i;
    while ((n = w.nextNode())) {
      if (k < n.data.length) {
        const r = document.createRange();
        r.setStart(n, k); r.setEnd(n, k + 1);
        return r.getBoundingClientRect();
      }
      k -= n.data.length;
    }
    return null;
  };
  const rows = [];
  for (const [serverRow, el] of g.rowEls) {
    if (serverRow < 0) continue;
    const r = el.getBoundingClientRect();
    if (r.top >= wr.top && r.bottom <= wr.bottom) rows.push([serverRow, el]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const pick = rows.length ? [rows[0], rows[rows.length >> 1], rows[rows.length - 1]] : [];
  for (const [serverRow, el] of pick) {
    const len = el.textContent.length;
    for (const ci of [...new Set([0, Math.min(9, len - 1), len - 1])]) {
      if (ci < 0) continue;
      const b = charBox(el, ci);
      if (!b || !b.width) continue;
      for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) {
        const e = { clientX: b.left + b.width * fx, clientY: b.top + b.height * fy };
        const got = gridCellFromEvent(g, e);
        const want = { col: ci + 1, row: serverRow + 1 };
        out.checked++;
        if (!got || got.col !== want.col || got.row !== want.row)
          out.bad.push({ want, got, at: [fx, fy] });
      }
    }
  }
  const c = g.cursor, rowEl = c && g.rowEls.get(c.row);
  if (rowEl) {
    const cr = g.cursorEl.getBoundingClientRect(), rr = rowEl.getBoundingClientRect();
    const cb = charBox(rowEl, c.col);
    const left = cb ? cb.left : rr.left + c.col * g.charWidth;
    out.cursor = { dTop: +(cr.top - rr.top).toFixed(2), dLeft: +(cr.left - left).toFixed(2),
                   dHeight: +(cr.height - rr.height).toFixed(2) };
  }
  return out;
}"""

GEOM_TOL = 1.0  # px: cursor box vs its laid-out cell


def check_geometry(slug, label, geo, findings):
    if geo.get("error"):
        findings.append((slug, "geometry", "%s: %s" % (label, geo["error"])))
        return geo
    if geo["checked"] == 0:
        findings.append((slug, "geometry", "%s: no visible cells sampled" % label))
    for b in geo["bad"]:
        findings.append((slug, "geometry", "%s: click at %s of cell %s resolved to %s"
                         % (label, b["at"], b["want"], b["got"])))
    cur = geo.get("cursor")
    if not cur:
        findings.append((slug, "geometry", "%s: cursor row not mounted" % label))
    elif max(abs(cur["dTop"]), abs(cur["dLeft"]), abs(cur["dHeight"])) > GEOM_TOL:
        findings.append((slug, "geometry", "%s: cursor off its cell %s" % (label, cur)))
    return geo


AA = 4.5  # WCAG AA, normal text


def parse_color(s):
    """'#rrggbb' / '#rgb' / 'rgb(r, g, b)' / 'rgba(r, g, b, a)' -> (r, g, b, a)."""
    s = (s or "").strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", s)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
    m = re.fullmatch(r"rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)", s)
    if m:
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return (round(float(m.group(1))), round(float(m.group(2))), round(float(m.group(3))), a)
    return None


def contrast(c1, c2):
    def lum(c):
        ch = []
        for v in c[:3]:
            v = v / 255.0
            ch.append(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
    a, b = lum(c1), lum(c2)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def check_palette(slug, pal, findings):
    """Contrast + single-source + opacity + monospace gate. Returns a record."""
    bg = parse_color(pal["bg"])
    if bg is None:
        findings.append((slug, "palette", "terminal background unreadable: %r" % pal["bg"]))
        return {"error": "no bg"}
    rows = []
    for i, c in enumerate(pal["ansi"] + [pal["fg"]]):
        name = "ansi-%d" % i if i < 16 else "fg"
        col = parse_color(c)
        if col is None:
            findings.append((slug, "palette", "%s unreadable: %r" % (name, c)))
            continue
        # Reverse video swaps fg and bg, so the pair's ratio is the same.
        r = round(contrast(col, bg), 2)
        rows.append({"name": name, "color": c, "ratio": r})
        if r < AA:
            findings.append((slug, "contrast", "%s %s is %.2f:1 on %s (< %.1f)"
                             % (name, c, r, pal["bg"], AA)))
    if [parse_color(x) for x in pal["xtermAnsi"]] != [parse_color(x) for x in pal["ansi"]] \
            or parse_color(pal["xtermBg"]) != bg or parse_color(pal["xtermFg"]) != parse_color(pal["fg"]):
        findings.append((slug, "palette", "xterm theme does not match termPalette()"))
    for key in ("gridBg", "areaBg"):
        c = parse_color(pal[key])
        if c is None or c[:3] != bg[:3] or c[3] < 1.0:
            findings.append((slug, "palette", "%s %r is not the opaque terminal background %s"
                             % (key, pal[key], pal["bg"])))
    gfg = parse_color(pal["gridFg"])
    if gfg is None or gfg[:3] != parse_color(pal["fg"])[:3]:
        findings.append((slug, "palette", "grid fg %r != terminal fg %s" % (pal["gridFg"], pal["fg"])))
    if "monospace" not in (pal["gridFont"] or ""):
        findings.append((slug, "palette", "grid font is not monospace: %r" % pal["gridFont"]))
    return {"bg": pal["bg"], "min": min((r["ratio"] for r in rows), default=None), "colors": rows}


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
                page.evaluate(ARM, SESSIONS)
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
                floor = TERMINAL_FLOOR.get(slug)
                area = (app.get("terminal") or {}).get("areaPx", 0)
                if floor and area < floor:
                    findings.append((slug, "terminal-area", "terminal %s px^2 < pre-T07 %s"
                                     % (area, floor)))

                # -- terminal palette (T05): contrast, one source, opaque ------
                if self_test and idx == 0:
                    # A stock-yellow ANSI 3 (1.6:1 on the pale terminal) must fail.
                    page.evaluate("""() => { termPaletteCache = null;
                      document.documentElement.style.setProperty('--ansi-3', '#FFCC00'); }""")
                entry["palette"] = check_palette(slug, page.evaluate(PALETTE), findings)
                if self_test and idx == 0:
                    page.evaluate("""() => { termPaletteCache = null;
                      document.documentElement.style.removeProperty('--ansi-3'); }""")

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

                # -- cell geometry (T11), then again after a font-size change --
                if self_test and idx == 0:
                    # A cell model 10% wider than the laid-out glyphs must fail;
                    # setFontSize below drops the corrupted cache again.
                    page.evaluate("() => { gridTerms[activeSession].charWidth *= 1.1; }")
                geo = {"base": check_geometry(slug, "base", page.evaluate(GEOMETRY), findings)}
                page.evaluate("() => { window.__fs0 = getFontSize(); setFontSize(window.__fs0 + 3); }")
                page.wait_for_timeout(300)
                # Taller rows push the viewport below the fold (no server here
                # to answer the resize); follow it down, as a reader would.
                page.evaluate("() => { const w = gridTerms[activeSession].wrap;"
                              " w.scrollTop = w.scrollHeight; }")
                page.wait_for_timeout(300)
                geo["font+3"] = check_geometry(slug, "font+3", page.evaluate(GEOMETRY), findings)
                page.evaluate("() => setFontSize(window.__fs0)")
                page.wait_for_timeout(300)
                entry["geometry"] = geo

                # -- side pane (T07): rows, order, diff, targets, open/close -----
                page.evaluate("() => closeSettings()")
                page.wait_for_timeout(200)
                entry["sidepane"] = check_sidepane(page, slug, out, pngs, findings, self_test)

                # -- keyboard layer (T08): prefix, overlays, focus reports -------
                entry["shortcuts"] = check_shortcuts(page, slug, out, pngs, findings, self_test)

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
                floor = TERMINAL_FLOOR.get(slug)
                if floor:
                    print("   area      %s px^2 vs pre-T07 %s (%+.1f%%)"
                          % (t.get("areaPx"), floor, (t.get("areaPx", 0) - floor) * 100.0 / floor))
                sp = entry.get("sidepane", {})
                print("   sidepane  %s; rows %s; targets <44: %d"
                      % (sp.get("mode"), (sp.get("closed") or {}).get("order"),
                         len((sp.get("targets") or {}).get("under44", []))))
                n_sc = len([f for f in findings if f[0] == slug and f[1] == "shortcuts"])
                print("   keys      %s" % ("ok" if not n_sc else "%d finding(s)" % n_sc))
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
    pal = metrics[PROFILES[-1][0]].get("palette", {})
    print("\nterminal palette on %s (WCAG AA >= %.1f; reverse video has the same ratio):"
          % (pal.get("bg"), AA))
    for r in pal.get("colors", []):
        print("   %-8s %-9s %5.2f:1%s" % (r["name"], r["color"], r["ratio"],
                                          "" if r["ratio"] >= AA else "  < AA"))
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
        print("GATE PASSED: no console errors, page errors or CSP violations; CSP matches server.js;"
              " terminal palette AA, single-source, opaque, monospace;"
              " grid cell geometry + cursor match layout (incl. after a font-size change);"
              " side pane rows/order/diff/targets/open-close; terminal area >= pre-T07;"
              " ctrl+b prefix + passthrough bytes, Cmd-K switcher, ? list, focus reports")

    if self_test:
        kinds = {k for s, k, t in findings
                 if SELF_TEST_MARK in t or (k == "csp-violation" and "script-src" in t)
                 or (k == "contrast" and "#FFCC00" in t)
                 or (k == "geometry" and s == PROFILES[0][0] and t.startswith("base:"))
                 or (k == "sidepane" and s == PROFILES[0][0] and "rebuilt rows" in t)
                 or (k == "shortcuts" and s == PROFILES[0][0] and "prefix passthrough" in t)}
        want = {"csp-violation", "console-error", "pageerror", "contrast", "geometry", "sidepane",
                "shortcuts"}
        missed = want - kinds
        if missed:
            print("SELF-TEST BROKEN: gate did not catch %s" % sorted(missed))
            return 2
        print("SELF-TEST OK: gate caught all injected faults %s -> exit 1" % sorted(want))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
