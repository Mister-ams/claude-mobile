#!/usr/bin/env python3
"""Live WebKit iPad harness against a THROWAWAY claude-mobile instance.

The iPad is the target device and WebKit is its engine, so this drives
Playwright's WebKit with the 'iPad Pro 11 landscape' profile (rotated to
portrait in the rotate step) against a real server on the herdr backend --
never the live one. Bring the throwaway up and down with
scripts/throwaway-instance.js.

Every step is a named PASS/FAIL with a screenshot. The live instance is only
ever READ: its /health before and after, and `herdr session list --json`
entries for its `cm-N` sessions. A change there is a FAIL, whatever else
passed.

  npm run sim:up            # prints TOTP_SECRET_FILE=<path>, never the secret
  npm run test:ipad-live    # the line below, with --known-defects send-pointer
  npm run sim:down

  py test/ipad-webkit-live.py --port 3457 \
      --totp-secret-file .totp-secret [--known-defects send-pointer]

--known-defects names steps that fail because of a real, TRACKED client defect
(send-pointer: T09). The run exits 0 only when every failure is on that list,
and prints each one loudly; without the flag any failure exits 1. A listed
step that starts passing is reported so the entry can be removed.

Windows note (D5): WebKit on Windows reports navigator.maxTouchPoints=0, so a
tap reaches the page as mouse/pointer events, not touch. That is recorded in
the report, never failed on.

Selectors live in SEL below and nowhere else: later tasks restyle the DOM,
and one dict is one place to follow them.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import struct
import subprocess
import sys
import time
import traceback
import urllib.request

from playwright.sync_api import sync_playwright

# ── DOM selectors: the ONLY place the harness names page structure ──────────
SEL = {
    "auth_screen": "#auth-screen",
    "totp_input": "#totp-input",
    "totp_submit": "#auth-submit-btn",
    "app": "#app",
    "app_shown_class": "shown",
    "empty_state": "#empty-state",
    "grid_row": ".grid-row",
    "grid_term": ".grid-term",
    "active_grid": ".term-wrap.active .grid-term",
    "msg_input": "#msg",
    "send_btn": "#send",
}

LIVE_PORT = 3456                      # D6: read-only, never a target
LIVE_SESSION_RE = re.compile(r"^cm-\d+$")
PROFILE_LANDSCAPE = "iPad Pro 11 landscape"
PROFILE_PORTRAIT = "iPad Pro 11"
HERDR = os.environ.get("HERDR_BIN") or os.path.expanduser(r"~\tools\herdr\herdr.exe")
HERE = os.path.dirname(os.path.abspath(__file__))


# ── helpers ─────────────────────────────────────────────────────────────────

def totp(secret_b32, when=None, period=30, digits=6):
    """RFC 6238, so the harness needs no TOTP dependency of its own."""
    s = secret_b32.strip().replace(" ", "").upper()
    key = base64.b32decode(s + "=" * (-len(s) % 8))
    counter = int((when or time.time()) // period)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def read_secret(path):
    """The instance writes {"secret": ...}; a bare base32 line is accepted too.
    The value is returned, never printed."""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    try:
        return json.loads(raw)["secret"]
    except (ValueError, KeyError, TypeError):
        return raw


def get_health(port, timeout=30):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            with urllib.request.urlopen("http://localhost:%d/health" % port, timeout=3) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # not up yet
            last = e
            time.sleep(0.5)
    raise RuntimeError("port %d never answered /health: %s" % (port, last))


def herdr_env(session=None):
    env = dict(os.environ)
    # An ambient HERDR_SESSION / HERDR_PANE_ID would silently redirect every
    # call to someone else's pane. Only ever the one we name.
    env.pop("HERDR_SESSION", None)
    env.pop("HERDR_PANE_ID", None)
    if session:
        env["HERDR_SESSION"] = session
    return env


def herdr_sessions():
    out = subprocess.run([HERDR, "session", "list", "--json"], capture_output=True,
                         text=True, env=herdr_env(), timeout=25)
    if out.returncode != 0:
        raise RuntimeError("herdr session list failed: %s" % out.stderr.strip()[:200])
    return json.loads(out.stdout)["sessions"]


def live_session_view(sessions):
    """The live instance's sessions, as identity: name, running, socket."""
    return sorted(
        [{"name": s.get("name"), "running": s.get("running"), "socket_path": s.get("socket_path")}
         for s in sessions if LIVE_SESSION_RE.match(str(s.get("name", "")))],
        key=lambda s: s["name"])


class Herdr:
    """CLI bound to ONE throwaway session. Refuses anything that could be live."""

    def __init__(self, session, prefix, config_path):
        if not re.match(r"^%s-\d+$" % re.escape(prefix), session) or LIVE_SESSION_RE.match(session):
            raise RuntimeError("refusing herdr session %r (not a %s-N throwaway)" % (session, prefix))
        self.session = session
        self.env = herdr_env(session)
        self.env["HERDR_CONFIG_PATH"] = config_path

    def cli(self, *args):
        r = subprocess.run([HERDR, *args], capture_output=True, text=True,
                           env=self.env, timeout=25)
        if r.returncode != 0:
            raise RuntimeError("herdr %s: %s" % (" ".join(args), (r.stderr or r.stdout).strip()[:200]))
        return r.stdout.strip()

    def snapshot(self):
        return json.loads(self.cli("api", "snapshot"))["result"]["snapshot"]

    def layout(self):
        """(focused_pane_id, panes) for the layout holding the focused pane."""
        snap = self.snapshot()
        focused = snap.get("focused_pane_id")
        layouts = [l for l in (snap.get("layouts") or []) if l.get("panes")]
        for l in layouts:
            if any(p["pane_id"] == focused for p in l["panes"]):
                return focused, l["panes"]
        return focused, (layouts[0]["panes"] if layouts else [])


# ── page probes (client globals: gridTerms, activeSession, sessionList, ws) ──

GRID_STATE = """(sel) => {
  const g = (typeof gridTerms !== 'undefined' && typeof activeSession !== 'undefined'
             && activeSession !== null) ? gridTerms[activeSession] : null;
  const rows = [...document.querySelectorAll(sel.grid_row)];
  const text = rows.map(e => e.innerText).join('\\n');
  return {
    sessions: (typeof sessionList !== 'undefined' && sessionList) ? sessionList.map(s => s.id) : [],
    active: (typeof activeSession !== 'undefined') ? activeSession : null,
    nonEmptyRows: rows.filter(e => e.innerText.trim()).length,
    text,
    mouse: g ? g.mouse : null,
    cols: g ? g.cols : null, rows: g ? g.rows : null,
    wsOpen: (typeof ws !== 'undefined' && !!ws && ws.readyState === 1),
    e2e: (typeof e2eReady !== 'undefined') ? e2eReady : null,
  };
}"""

CLAUDE_MARKER = """(sel) => {
  const t = [...document.querySelectorAll(sel.grid_row)].map(e => e.innerText).join('\\n');
  if (/Welcome to Claude Code/i.test(t)) return 'welcome-banner';
  if (/trust the files|Do you trust|trust this folder|Quick safety check/i.test(t)) return 'claude-trust-prompt';
  if (/claude\\.ai\\/code|Claude Code v/i.test(t)) return 'claude-banner';
  if (/esc to interrupt|\\? for shortcuts/i.test(t)) return 'claude-tui';
  return null;
}"""

# Server dims (from the snapshot) next to what the client wants at its size.
GRID_DIMS = """() => {
  const g = gridTerms[activeSession];
  if (!g) return null;
  const want = computeGridDims(g);
  return {
    serverCols: g.cols, serverRows: g.rows,
    wantCols: want ? want.cols : null, wantRows: want ? want.rows : null,
    converged: !!want && want.cols === g.cols && want.rows === g.rows,
    viewport: innerWidth + 'x' + innerHeight,
  };
}"""

# herdr cell (0-based col/row of the pane rect) -> page pixel, from the page's
# own geometry, so the harness never re-derives what the client already knows.
CELL_TO_PIXEL = """([col0, row0]) => {
  const grid = (typeof gridTerms !== 'undefined') ? gridTerms[activeSession] : null;
  if (!grid) return { err: 'no grid for the active session' };
  const el = grid.rowEls.get(row0);
  if (!el) return { err: 'server row ' + row0 + ' is not mounted' };
  const charW = (typeof measureCharWidth === 'function') ? measureCharWidth(grid) : grid.charWidth;
  if (!charW) return { err: 'char width unmeasurable' };
  const r = el.getBoundingClientRect();
  const w = grid.wrap.getBoundingClientRect();
  return { x: w.left - grid.wrap.scrollLeft + (col0 + 0.5) * charW, y: r.top + r.height / 2, charW };
}"""


# ── the run ─────────────────────────────────────────────────────────────────

class Run:
    def __init__(self, out):
        self.out = out
        self.results = []
        self.page = None
        self.n = 0

    def step(self, name, fn, needs=()):
        self.n += 1
        label = "%d-%s" % (self.n, name)
        blocked = [d for d in needs if not self.ok(d)]
        if blocked:
            ok, ev = False, "BLOCKED by failed step(s): %s" % ", ".join(blocked)
        else:
            try:
                ok, ev = fn()
            except Exception as e:
                ok, ev = False, "%s: %s" % (type(e).__name__, str(e)[:300])
                traceback.print_exc()
        shot = None
        if self.page is not None:
            shot = os.path.join(self.out, "%02d-%s.png" % (self.n, name))
            try:
                self.page.screenshot(path=shot)
            except Exception as e:
                shot = "screenshot failed: %s" % str(e)[:120]
        self.results.append({"step": label, "name": name, "ok": bool(ok),
                             "evidence": ev, "screenshot": shot})
        print("  %s  %-22s %s" % ("PASS" if ok else "FAIL", label, ev))
        return ok

    def ok(self, name):
        return any(r["name"] == name and r["ok"] for r in self.results)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3457)
    ap.add_argument("--totp-secret-file", required=True)
    ap.add_argument("--prefix", default="cmsim", help="throwaway herdr session prefix")
    ap.add_argument("--herdr-config", default=os.path.join(HERE, "..", "herdr-config.toml"))
    ap.add_argument("--live-port", type=int, default=LIVE_PORT)
    ap.add_argument("--claude-timeout", type=int, default=120)
    ap.add_argument("--out", default=os.path.join(os.environ.get("TEMP", "/tmp"),
                                                  "cm-ipad-live-%d" % int(time.time())))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--known-defects", default="",
                    help="comma-separated step names failing on a tracked defect (e.g. send-pointer)")
    args = ap.parse_args()
    known = {s.strip() for s in args.known_defects.split(",") if s.strip()}

    if args.port == args.live_port:
        print("refusing: --port %d is the live instance (D6)" % args.port)
        return 2
    if args.prefix == "cm" or LIVE_SESSION_RE.match(args.prefix + "-0"):
        print("refusing: prefix %r collides with the live cm-N sessions" % args.prefix)
        return 2

    secret = read_secret(args.totp_secret_file)
    base = "http://localhost:%d" % args.port
    herdr_config = os.path.abspath(args.herdr_config)
    os.makedirs(args.out, exist_ok=True)
    run = Run(args.out)
    st = {}  # state shared between steps

    print("throwaway %s, live %d (read-only), out %s" % (base, args.live_port, args.out))

    def login(page):
        page.goto(base + "/", wait_until="load")
        page.wait_for_selector(SEL["auth_screen"], state="visible", timeout=15000)
        page.wait_for_timeout(600)
        if time.time() % 30 > 27:  # a code at the end of its window expires mid-flight
            time.sleep(4)
        page.fill(SEL["totp_input"], totp(secret))
        page.click(SEL["totp_submit"])
        page.wait_for_function(
            "([app, cls]) => document.querySelector(app).classList.contains(cls)",
            arg=[SEL["app"], SEL["app_shown_class"]], timeout=20000)
        page.wait_for_timeout(800)

    def grid(page):
        return page.evaluate(GRID_STATE, SEL)

    def wait_grid(page, pred, timeout_s):
        end = time.time() + timeout_s
        g = grid(page)
        while time.time() < end and not pred(g):
            page.wait_for_timeout(500)
            g = grid(page)
        return pred(g), g

    def pixel(col0, row0):
        pos = run.page.evaluate(CELL_TO_PIXEL, [col0, row0])
        if "err" in pos:
            raise RuntimeError(pos["err"])
        return pos

    def centre(pane):
        r = pane["rect"]
        return pixel(r["x"] + max(0, r["width"] // 2), r["y"] + max(0, r["height"] // 2))

    def wait_focus(h, want_change_from=None, want=None, timeout_s=10):
        end = time.time() + timeout_s
        f, _ = h.layout()
        while time.time() < end:
            if want is not None and f == want:
                break
            if want_change_from is not None and f != want_change_from:
                break
            time.sleep(0.25)
            f, _ = h.layout()
        return f

    def wait_converged(timeout_s=20):
        end = time.time() + timeout_s
        d = None
        while time.time() < end:
            d = run.page.evaluate(GRID_DIMS)
            if d and d["converged"]:
                return True, d
            run.page.wait_for_timeout(400)
        return False, d

    with sync_playwright() as p:
        browser = p.webkit.launch(headless=not args.headed)
        land = p.devices[PROFILE_LANDSCAPE]
        port_ = p.devices[PROFILE_PORTRAIT]
        errs = []

        def new_page():
            ctx = browser.new_context(**land)
            pg = ctx.new_page()
            # TOFU pins the server key behind a native confirm(); headless would
            # auto-dismiss it and close the socket.
            pg.on("dialog", lambda d: d.accept())
            pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
            return ctx, pg

        # ── 1. before-snapshot of the LIVE instance (read-only) ───────────
        def s_before():
            st["live_before"] = get_health(args.live_port, timeout=10)
            st["live_sessions_before"] = live_session_view(herdr_sessions())
            st["t_before"] = time.time()
            h = get_health(args.port)
            st["throwaway_health"] = h
            ctx, pg = new_page()
            st["ctx"] = ctx
            run.page = pg
            pg.goto(base + "/", wait_until="load")
            lb = st["live_before"]
            ok = lb.get("status") == "ok" and h.get("backend") == "herdr"
            return ok, ("live %d: status=%s backend=%s sessions=%s uptime=%ss; live herdr %s; "
                        "throwaway backend=%s" % (
                            args.live_port, lb.get("status"), lb.get("backend"), lb.get("sessions"),
                            lb.get("uptime"),
                            [(s["name"], s["running"]) for s in st["live_sessions_before"]],
                            h.get("backend")))
        run.step("live-before", s_before)

        # ── 2. sign in, iPad Pro 11 landscape ─────────────────────────────
        def s_signin():
            login(run.page)
            st["maxTouchPoints"] = run.page.evaluate("navigator.maxTouchPoints")
            st["ua_ipad"] = "iPad" in run.page.evaluate("navigator.userAgent")
            vp = run.page.evaluate("innerWidth + 'x' + innerHeight")
            return True, "app shown at %s; UA iPad=%s; maxTouchPoints=%s (taps arrive as mouse events)" % (
                vp, st["ua_ipad"], st["maxTouchPoints"])
        run.step("sign-in", s_signin, needs=("live-before",))

        # ── 3. a session exists and its screen is shown on a fresh sign-in ─
        def s_existing():
            g = grid(run.page)
            created = False
            if not g["sessions"]:
                run.page.click(SEL["empty_state"])
                created = True
            ok, g = wait_grid(run.page, lambda g: g["active"] is not None and g["nonEmptyRows"] > 0, 45)
            if not ok:
                return False, "no session content after 45s (sessions=%s)" % g["sessions"]
            end = time.time() + args.claude_timeout
            marker = None
            while time.time() < end and not marker:
                marker = run.page.evaluate(CLAUDE_MARKER, SEL)
                if not marker:
                    run.page.wait_for_timeout(1000)
            sid = g["active"]
            st["sid"] = sid
            # The real claim: a SECOND sign-in lands on that session's screen
            # without creating anything.
            st["ctx"].close()
            ctx, pg = new_page()
            st["ctx"], run.page = ctx, pg
            login(pg)
            ok2, g2 = wait_grid(pg, lambda g: g["active"] == sid and g["nonEmptyRows"] > 0, 20)
            st["session_count"] = len(g2["sessions"])
            return ok2 and g2["sessions"] == [sid], (
                "session %s (created by harness=%s), claude marker=%s; fresh sign-in shows it: "
                "active=%s sessions=%s rows painted=%d" % (
                    sid, created, marker, g2["active"], g2["sessions"], g2["nonEmptyRows"]))
        run.step("existing-screen", s_existing, needs=("sign-in",))

        # ── 4. split the throwaway pane; a tap moves herdr focus ──────────
        def s_tap():
            name = "%s-%s" % (args.prefix, st["sid"])
            running = [s for s in herdr_sessions() if s.get("name") == name and s.get("running")]
            if not running:
                return False, "herdr session %s not running" % name
            h = Herdr(name, args.prefix, herdr_config)
            st["herdr"] = h
            f0, panes0 = h.layout()
            if len(panes0) != 1:
                return False, "expected 1 pane before split, got %d" % len(panes0)
            orig = panes0[0]["pane_id"]
            st["orig_pane"] = orig
            h.cli("pane", "split", orig, "--direction", "right")
            time.sleep(2.5)
            focused, panes = h.layout()
            if len(panes) != 2:
                return False, "split produced %d panes" % len(panes)
            st["new_pane"] = next(q["pane_id"] for q in panes if q["pane_id"] != orig)
            ok, g = wait_grid(run.page, lambda g: g["mouse"] and g["mouse"].get("tracking") != "none", 20)
            if not ok:
                return False, "client never learned herdr wants mouse: %s" % (g["mouse"],)
            home = next(q for q in panes if q["pane_id"] == focused)
            other = next(q for q in panes if q["pane_id"] != focused)
            # CONTROL: tapping the already-focused pane must not move focus.
            c = centre(home)
            run.page.mouse.click(c["x"], c["y"])
            time.sleep(2)
            ctrl, _ = h.layout()
            if ctrl != focused:
                return False, "control tap on focused pane moved focus %s -> %s" % (focused, ctrl)
            t = centre(other)
            run.page.mouse.click(t["x"], t["y"])
            after = wait_focus(h, want_change_from=focused)
            return after == other["pane_id"], (
                "mouse tracking=%s; control tap kept %s; tap at %.0f,%.0f moved focus %s -> %s (aimed %s)" % (
                    g["mouse"].get("tracking"), focused, t["x"], t["y"], focused, after, other["pane_id"]))
        run.step("tap-focus", s_tap, needs=("existing-screen",))

        # ── 5. drag the split border; herdr's pane rects change ───────────
        def s_drag():
            h = st["herdr"]
            _, panes = h.layout()
            left, right = sorted(panes, key=lambda q: q["rect"]["x"])
            lr, rr = left["rect"], right["rect"]
            # The divider is the column between the two rects; with no gap it is
            # the left pane's last column.
            border = lr["x"] + lr["width"] if rr["x"] > lr["x"] + lr["width"] else lr["x"] + lr["width"] - 1
            row0 = lr["y"] + max(1, lr["height"] // 2)
            start = pixel(border, row0)
            shift = -12
            run.page.mouse.move(start["x"], start["y"])
            run.page.mouse.down()
            for i in range(1, 7):
                run.page.mouse.move(start["x"] + shift * start["charW"] * i / 6, start["y"])
                run.page.wait_for_timeout(120)
            run.page.mouse.up()
            end = time.time() + 6
            w_after = lr["width"]
            while time.time() < end:
                _, panes2 = h.layout()
                l2 = sorted(panes2, key=lambda q: q["rect"]["x"])[0]["rect"]
                w_after = l2["width"]
                if w_after != lr["width"]:
                    break
                time.sleep(0.3)
            return w_after != lr["width"], (
                "left pane %sx%s + right %sx%s; dragged border col %d by %d cols; left width %d -> %d" % (
                    lr["width"], lr["height"], rr["width"], rr["height"], border, shift, lr["width"], w_after))
        run.step("drag-resize", s_drag, needs=("tap-focus",))

        # ── 6. typed input echoes in the grid (into the SHELL pane only) ──
        def s_echo():
            h = st["herdr"]
            focused, panes = h.layout()
            shell = next(q for q in panes if q["pane_id"] == st["new_pane"])
            if focused != shell["pane_id"]:
                c = centre(shell)
                run.page.mouse.click(c["x"], c["y"])
                focused = wait_focus(h, want=shell["pane_id"])
            if focused != shell["pane_id"]:
                # Typing now would prompt Claude in the other pane. Refuse.
                return False, "could not focus the shell pane %s (focused %s); not typing" % (
                    shell["pane_id"], focused)
            token = "CMSIM" + secrets.token_hex(4).upper()
            run.page.fill(SEL["msg_input"], "echo " + token)
            # A finger on Send: the touch path (touchend handler).
            run.page.tap(SEL["send_btn"])
            # Command line + its output = at least two occurrences.
            ok, g = wait_grid(run.page, lambda g: g["text"].count(token) >= 2, 15)
            pane_txt = h.cli("pane", "read", shell["pane_id"], "--source", "recent")
            return ok, "typed 'echo %s', tapped Send, into shell pane %s; grid occurrences=%d; herdr pane read has it=%s" % (
                token, shell["pane_id"], g["text"].count(token), token in pane_txt)
        run.step("typed-echo", s_echo, needs=("tap-focus",))

        # ── 6b. Send clicked with a POINTER (iPad trackpad / Magic Keyboard) ─
        # Separate from 6 because it is a different input path: pointerdown on
        # the button blurs the compose box first, and in hardware-keyboard mode
        # that blur is what decides whether the button is still there.
        def s_send_pointer():
            h = st["herdr"]
            focused, _ = h.layout()
            if focused != st["new_pane"]:
                return False, "shell pane no longer focused (%s); not typing" % focused
            token = "CMSIM" + secrets.token_hex(4).upper()
            run.page.fill(SEL["msg_input"], "echo " + token)
            body = run.page.evaluate("document.body.className")
            run.page.click(SEL["send_btn"])
            ok, g = wait_grid(run.page, lambda g: g["text"].count(token) >= 2, 10)
            left = run.page.input_value(SEL["msg_input"])
            return ok, "pointer click on Send (body class '%s'): grid occurrences=%d, compose box after=%r%s" % (
                body, g["text"].count(token), left,
                "" if ok else " -- click lost: the blur hides #send before mouseup")
        run.step("send-pointer", s_send_pointer, needs=("typed-echo",))

        # ── 7. rotate: server dims converge to the client both ways ───────
        def s_rotate():
            steps = []
            ok0, d0 = wait_converged()
            steps.append(("landscape", ok0, d0))
            pv = port_["viewport"]
            run.page.set_viewport_size(pv)
            run.page.wait_for_timeout(600)
            okp, dp = wait_converged()
            steps.append(("portrait", okp, dp))
            run.page.screenshot(path=os.path.join(args.out, "07-rotate-portrait.png"))
            run.page.set_viewport_size(land["viewport"])
            run.page.wait_for_timeout(600)
            okl, dl = wait_converged()
            steps.append(("landscape", okl, dl))
            g = grid(run.page)
            ev = "; ".join("%s %s server %sx%s want %sx%s %s" % (
                n, d and d["viewport"], d and d["serverCols"], d and d["serverRows"],
                d and d["wantCols"], d and d["wantRows"], "ok" if ok else "STUCK") for n, ok, d in steps)
            return all(s[1] for s in steps) and g["nonEmptyRows"] > 0, ev
        run.step("rotate", s_rotate, needs=("existing-screen",))

        # ── 8. reconnect: dropped socket and a full reload ────────────────
        def s_reconnect():
            sid = st["sid"]
            run.page.evaluate("() => { window.__oldWs = ws; ws.close(); }")
            ok1, g1 = wait_grid(run.page, lambda g: g["wsOpen"] and g["e2e"] and g["active"] == sid
                                and g["nonEmptyRows"] > 0, 25)
            fresh = run.page.evaluate("() => ws !== window.__oldWs")
            run.page.reload(wait_until="load")
            login(run.page)
            ok2, g2 = wait_grid(run.page, lambda g: g["active"] == sid and g["nonEmptyRows"] > 0, 20)
            _, panes = st["herdr"].layout()
            same = g2["sessions"] == [sid] and len(panes) == 2
            return ok1 and fresh and ok2 and same, (
                "ws drop: reconnected=%s new socket=%s active=%s rows=%d; reload+sign-in: active=%s "
                "sessions=%s rows=%d; herdr panes still %d" % (
                    ok1, fresh, g1["active"], g1["nonEmptyRows"], g2["active"], g2["sessions"],
                    g2["nonEmptyRows"], len(panes)))
        run.step("reconnect", s_reconnect, needs=("existing-screen",))

        # ── 9. after-snapshot of the LIVE instance ────────────────────────
        def s_after():
            if "live_before" not in st:
                return False, "no before-snapshot to compare against"
            la = get_health(args.live_port, timeout=10)
            sa = live_session_view(herdr_sessions())
            lb, sb = st["live_before"], st["live_sessions_before"]
            elapsed = time.time() - st["t_before"]
            diffs = []
            for k in ("status", "backend", "backendAvailable", "sessions"):
                if la.get(k) != lb.get(k):
                    diffs.append("%s %r -> %r" % (k, lb.get(k), la.get(k)))
            if la.get("status") != "ok" or la.get("backend") != "herdr":
                diffs.append("live not ok/herdr: status=%s backend=%s" % (la.get("status"), la.get("backend")))
            # A restart resets uptime; no restart means it only grew.
            if la.get("uptime", 0) < lb.get("uptime", 0) + int(elapsed) - 5:
                diffs.append("uptime %s -> %s over %ds (restarted?)" % (lb.get("uptime"), la.get("uptime"), elapsed))
            if sa != sb:
                diffs.append("live herdr sessions %s -> %s" % (sb, sa))
            st["live_after"], st["live_sessions_after"] = la, sa
            return not diffs, ("unchanged: status=%s backend=%s sessions=%s uptime %s->%s; herdr %s" % (
                la.get("status"), la.get("backend"), la.get("sessions"), lb.get("uptime"), la.get("uptime"),
                [(s["name"], s["running"], s["socket_path"]) for s in sa])) if not diffs else "; ".join(diffs)
        run.step("live-after", s_after)

        browser.close()

    report = {
        "port": args.port, "livePort": args.live_port, "prefix": args.prefix,
        "profiles": [PROFILE_LANDSCAPE, PROFILE_PORTRAIT],
        "maxTouchPoints": st.get("maxTouchPoints"),
        "liveBefore": st.get("live_before"), "liveAfter": st.get("live_after"),
        "liveSessionsBefore": st.get("live_sessions_before"),
        "liveSessionsAfter": st.get("live_sessions_after"),
        "steps": run.results, "pageErrors": errs[:20],
    }
    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    bad = [r for r in run.results if not r["ok"]]
    for e in errs[:5]:
        print("  NOTE  pageerror %s" % e)
    print("\n%d passed, %d failed -- report %s" % (len(run.results) - len(bad), len(bad),
                                                    os.path.join(args.out, "report.json")))
    known_bad = [r for r in bad if r["name"] in known]
    unknown_bad = [r for r in bad if r["name"] not in known]
    if known_bad:
        print("\n" + "!" * 72)
        for r in known_bad:
            print("!! KNOWN DEFECT (tracked, still failing): %s -- %s" % (r["step"], r["evidence"]))
        print("!" * 72)
    for name in sorted(known - {r["name"] for r in bad}):
        if any(r["name"] == name for r in run.results):
            print("NOTE  known defect %r now PASSES -- remove it from --known-defects" % name)
        else:
            print("NOTE  --known-defects names %r, which is not a step" % name)
    return 1 if unknown_bad else 0


if __name__ == "__main__":
    sys.exit(main())
