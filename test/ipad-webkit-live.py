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
  npm run test:ipad-live    # the line below (no known defects since T09)
  npm run sim:down

  py test/ipad-webkit-live.py --port 3457 \
      --totp-secret-file .totp-secret [--known-defects <step,...>]

--known-defects names steps that fail because of a real, TRACKED client defect
(send-pointer was one until T09 fixed it). The run exits 0 only when every failure is on that list,
and prints each one loudly; without the flag any failure exits 1. A listed
step that starts passing is reported so the entry can be removed.

T08 steps (after reconnect, since they add a pane and a session):
focus-report (a probe in the shell pane asks for CSI ?1004h; page blur/focus
must reach it as ^[[O / ^[[I), prefix-passthrough (ctrl+b v typed into the web
client splits the herdr pane), session-switch (a second session via the UI;
ctrl+b n follows side-pane order, ctrl+b a jumps to an unseen finish).

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
import threading
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
    # T07: the sessions side pane; rows keyed by session id.
    "sidepane": "#sidepane",
    "sp_list": "#sp-list",
    "sp_row": ".sp-row",
    "sp_toggle": "#sp-toggle",
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


class HerdrEventTap:
    """The harness's OWN events.subscribe on one throwaway session (T06).

    It exists to timestamp when herdr REPORTED a status change, so the client's
    receipt can be measured against it rather than against when the harness
    happened to ask. Same wire shape as lib/herdr-events.js: newline-delimited
    JSON over the named pipe \\\\.\\pipe\\<socket_path>. The reader is a daemon
    thread that ends when herdr closes the pipe; it is never closed from here,
    because closing a synchronous Windows handle under a blocked ReadFile can
    hang the closer.
    """

    def __init__(self, session, prefix, pane_ids):
        if not re.match(r"^%s-\d+$" % re.escape(prefix), session) or LIVE_SESSION_RE.match(session):
            raise RuntimeError("refusing herdr session %r (not a %s-N throwaway)" % (session, prefix))
        rec = next((s for s in herdr_sessions() if s.get("name") == session and s.get("running")), None)
        if not rec:
            raise RuntimeError("herdr session %s not running" % session)
        self.f = open("\\\\.\\pipe\\" + rec["socket_path"], "r+b", buffering=0)
        req = {"id": "harness:subscribe", "method": "events.subscribe", "params": {"subscriptions": [
            {"type": "pane.agent_status_changed", "pane_id": p} for p in pane_ids]}}
        self.f.write((json.dumps(req) + "\n").encode("utf-8"))
        self.events = []        # (time.time(), status, pane_id)
        self.started = False
        self.closed = False
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        buf = b""
        while True:
            try:
                chunk = self.f.read(65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                t = time.time()
                try:
                    msg = json.loads(line.decode("utf-8"))
                except ValueError:
                    continue
                if (msg.get("result") or {}).get("type") == "subscription_started":
                    self.started = True
                elif msg.get("event") == "pane.agent_status_changed":
                    d = msg.get("data") or {}
                    self.events.append((t, d.get("agent_status"), d.get("pane_id")))
        self.closed = True

    def wait_for(self, status, start=0, timeout_s=60):
        end = time.time() + timeout_s
        while time.time() < end:
            for i in range(start, len(self.events)):
                if self.events[i][1] == status:
                    return i
            time.sleep(0.05)
        return None


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

# T06: record every change to one session's agent status AS THE PAGE SEES IT,
# stamped with the page clock (same machine clock as the harness). A 20ms poll
# of the client's own sessionList, so the stamp is at most 20ms late.
AGENT_RECORDER = """(sid) => {
  if (window.__agentRec) clearInterval(window.__agentRec);
  window.__agentLog = window.__agentLog || [];
  let last = null;
  window.__agentRec = setInterval(() => {
    const s = (typeof sessionList !== 'undefined' && sessionList) ? sessionList.find(x => x.id === sid) : null;
    const a = s ? s.agent : null;
    const e = { status: a ? a.status : null, herdr: a ? a.herdrStatus : null, feed: a ? a.feed : null,
                attention: s ? s.attention : null, reconnects: a ? a.reconnects : null,
                agent: a ? a.agent : null, present: !!s };
    const key = JSON.stringify(e);
    if (key !== last) { last = key; e.t = Date.now() / 1000; window.__agentLog.push(e); }
  }, 20);
  return true;
}"""

# T07: the side pane's row for one session AS DRAWN -- its data-status, glyph,
# position in the list and aria-label -- sampled every 20ms alongside the
# agent recorder, so a step can show the row followed herdr's transitions.
SP_ROW_RECORDER = """([sid, sel]) => {
  if (window.__spRec) clearInterval(window.__spRec);
  window.__spLog = window.__spLog || [];
  let last = null;
  window.__spRec = setInterval(() => {
    const list = document.querySelector(sel.sp_list);
    const rows = list ? [...list.querySelectorAll(':scope > ' + sel.sp_row)] : [];
    const i = rows.findIndex(r => r.dataset.id === String(sid));
    const r = i >= 0 ? rows[i] : null;
    const use = r ? r.querySelector('use') : null;
    const e = { status: r ? r.dataset.status : null, glyph: use ? use.getAttribute('href') : null,
                index: i, rows: rows.length,
                label: r ? r.querySelector('button').getAttribute('aria-label') : null };
    const key = JSON.stringify(e);
    if (key !== last) { last = key; e.t = Date.now() / 1000; window.__spLog.push(e); }
  }, 20);
  return true;
}"""

AGENT_OF = """(sid) => {
  const s = (typeof sessionList !== 'undefined' && sessionList) ? sessionList.find(x => x.id === sid) : null;
  return s ? { attention: s.attention, agent: s.agent } : null;
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
    ap.add_argument("--audit-log", default=None,
                    help="throwaway audit log (default: %%TEMP%%/cm-sim-<port>/audit.log, as sim:up writes it)")
    ap.add_argument("--known-defects", default="",
                    help="comma-separated step names failing on a tracked defect (e.g. send-pointer)")
    args = ap.parse_args()
    known = {s.strip() for s in args.known_defects.split(",") if s.strip()}
    if not args.audit_log:
        args.audit_log = os.path.join(os.environ.get("TEMP", "/tmp"), "cm-sim-%d" % args.port, "audit.log")

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
            # Only audit lines THIS run writes count (the log outlives sim:down).
            st["audit_offset"] = os.path.getsize(args.audit_log) if os.path.exists(args.audit_log) else 0
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

        # -- 3b. herdr agent status reaches the client (T06, D7) -----------
        # A REAL transition, provoked deterministically: Claude is asked to use
        # its AskUserQuestion tool, which herdr classifies as `blocked`
        # (working -> blocked); the harness answers it through herdr
        # (blocked -> working -> idle). A permission prompt would be the more
        # obvious choice but is not deterministic here -- Claude may run in auto
        # mode and never ask. herdr's own report is timestamped by the
        # harness's own subscription (HerdrEventTap); the client's receipt by
        # the page recorder. Every transition the page shows must land within
        # 2s of herdr reporting it.
        def page_log():
            return run.page.evaluate("() => window.__agentLog || []")

        def wait_page(pred, start=0, timeout_s=10):
            end = time.time() + timeout_s
            while time.time() < end:
                log = page_log()
                for i in range(start, len(log)):
                    if pred(log[i]):
                        return i, log[i]
                run.page.wait_for_timeout(50)
            return None, None

        def latencies(tap, first_event, page_start):
            """Pair each herdr event with the first later page entry showing it."""
            out, j = [], page_start
            log = page_log()
            for (t_h, status, pane) in tap.events[first_event:]:
                k = next((i for i in range(j, len(log))
                          if log[i]["herdr"] == status and log[i]["t"] >= t_h - 0.1), None)
                if k is None:
                    out.append((status, None))
                    continue
                out.append((status, round(log[k]["t"] - t_h, 3)))
                j = k
            return out

        def claude_agent(h):
            agents = json.loads(h.cli("agent", "list"))["result"]["agents"]
            return next((a for a in agents if a.get("agent") == "claude"), None)

        def s_agent_status():
            sid = st["sid"]
            name = "%s-%s" % (args.prefix, sid)
            h = Herdr(name, args.prefix, herdr_config)
            st["herdr_agent"] = h
            # 1. the fields reach the client
            a0 = run.page.evaluate(AGENT_OF, sid)
            agent = (a0 or {}).get("agent") or {}
            missing = [k for k in ("status", "herdrStatus", "seen", "cwd", "title", "worktree", "feed")
                       if k not in agent]
            if missing:
                return False, "client session %s agent lacks %s: %s" % (sid, missing, a0)
            if agent.get("feed") != "events":
                return False, "feed is %r, not events -- the subscription is not live" % agent.get("feed")
            # 2. Claude settled (not mid-start)
            end = time.time() + 90
            ca = claude_agent(h)
            while time.time() < end and (not ca or ca["agent_status"] in ("working", "unknown")):
                time.sleep(0.5)
                ca = claude_agent(h)
            if not ca:
                return False, "no claude agent in %s after 90s" % name
            pane = ca["pane_id"]
            st["claude_pane"] = pane
            run.page.evaluate(AGENT_RECORDER, sid)
            run.page.evaluate(SP_ROW_RECORDER, [sid, SEL])
            tap = HerdrEventTap(name, args.prefix, [pane])
            end = time.time() + 5
            while time.time() < end and not tap.started:
                time.sleep(0.05)
            if not tap.started:
                return False, "harness subscription to %s never started" % name
            page0 = len(page_log())
            notes = []
            if ca["agent_status"] == "blocked":
                txt = h.cli("pane", "read", pane, "--source", "visible")
                if not re.search(r"trust this folder", txt, re.I):
                    return False, "claude already blocked on an unknown prompt; not answering it"
                # Fresh work dir: the folder-trust prompt IS the blocked state.
                notes.append("started blocked on folder-trust; accepted it")
                h.cli("agent", "send-keys", pane, "down", "enter")
                if tap.wait_for("idle", 0, 60) is None:
                    return False, "trust accepted but herdr never reported idle: %s" % tap.events
            ev0 = len(tap.events)
            h.cli("agent", "prompt", pane,
                  "Use the AskUserQuestion tool to ask me one question: pick A or B. Do nothing else.")
            ib = tap.wait_for("blocked", ev0, 90)
            if ib is None:
                return False, "herdr never reported blocked: %s" % tap.events[ev0:]
            _, pb = wait_page(lambda e: e["herdr"] == "blocked", page0, 5)
            if not pb or pb["attention"] != "permission":
                return False, "client never showed blocked+permission: %s" % page_log()[page0:]
            h.cli("agent", "send-keys", pane, "enter")
            ii = tap.wait_for("idle", ib + 1, 90)
            if ii is None:
                return False, "answered, but herdr never reported idle: %s" % tap.events[ib:]
            k, pd = wait_page(lambda e: e["herdr"] == "idle" and e["status"] == "done", page0, 5)
            if pd is None:
                return False, "client never showed the unseen finish as done: %s" % page_log()[page0:]
            done_attn = pd["attention"]
            lat = latencies(tap, ev0, page0)
            # 3. viewing the session clears done (the client re-sends connect)
            run.page.evaluate("(sid) => switchTo(sid)", sid)
            _, pv = wait_page(lambda e: e["status"] == "idle" and e["attention"] is None, k + 1, 5)
            # 4. the regex detector did not run for this herdr session
            attn_miss = None
            if os.path.exists(args.audit_log):
                with open(args.audit_log, "rb") as f:
                    f.seek(st.get("audit_offset", 0))
                    attn_miss = f.read().decode("utf-8", "replace").count("[ATTN-MISS]")
            measured = [l for (_, l) in lat if l is not None]
            worst = max(measured) if measured else None
            st["agent_latency"] = lat
            ok = (worst is not None and worst <= 2.0
                  and all(l is not None for (s, l) in lat if s in ("blocked", "idle"))
                  and done_attn == "ready" and pv is not None and attn_miss == 0)
            return ok, ("%sfields %s; herdr %s -> client latency %s (worst %.3fs); blocked showed "
                        "attention=permission; finish showed done+attention=%s; after view: %s; "
                        "ATTN-MISS lines in audit=%s; cwd=%r title=%r worktree=%r" % (
                            ("; ".join(notes) + "; ") if notes else "",
                            sorted(agent.keys()), [s for (_, s, _) in tap.events[ev0:]],
                            lat, worst if worst is not None else -1, done_attn,
                            "idle/no attention" if pv else "STILL done", attn_miss,
                            agent.get("cwd"), agent.get("title"), agent.get("worktree")))
        run.step("agent-status", s_agent_status, needs=("existing-screen",))

        # -- 3c. the side pane row follows herdr's status (T07) --------------
        # Reads what the pane DREW during 3b: the row for the session must go
        # blocked (sorted first, exclamation glyph, "Needs input" in its
        # label), then done (check glyph, unseen), then idle once viewed --
        # blocked and done each within 2s of the client's own sessionList
        # showing them. The throwaway has one session, so "first" is trivially
        # true here; the multi-session priority order is proven by the static
        # tier's four-state fixture.
        def s_sidepane_status():
            sid = st["sid"]
            log = run.page.evaluate("() => window.__spLog || []")
            alog = page_log()
            seq = []
            for e in log:
                if not seq or seq[-1] != e["status"]:
                    seq.append(e["status"])

            def lag(status):
                a = next((e for e in alog if e["status"] == status), None)
                r = next((e for e in log if e["status"] == status
                          and (not a or e["t"] >= a["t"] - 0.05)), None)
                return (round(r["t"] - a["t"], 3) if (a and r) else None), r
            lb, rb = lag("blocked")
            ld, rd = lag("done")
            ri = next((e for e in log if e["status"] == "idle" and rd is not None and e["t"] > rd["t"]), None)
            now = run.page.evaluate("""(sel) => {
              const rows = [...document.querySelectorAll(sel.sp_list + ' > ' + sel.sp_row)];
              return { ids: rows.map(r => +r.dataset.id), sessions: sessionList.map(s => s.id) };
            }""", SEL)
            ok = (rb is not None and rb["index"] == 0 and rb["glyph"] == "#s-blocked"
                  and "Needs input" in (rb["label"] or "")
                  and rd is not None and rd["glyph"] == "#s-done"
                  and ri is not None
                  and lb is not None and lb <= 2.0 and ld is not None and ld <= 2.0
                  and sorted(now["ids"]) == sorted(now["sessions"]))
            return ok, ("row %s statuses %s; blocked: index=%s glyph=%s label=%r lag=%ss; done: glyph=%s "
                        "lag=%ss; idle after view=%s; rows now %s for sessions %s" % (
                            sid, seq, rb and rb["index"], rb and rb["glyph"], rb and rb["label"], lb,
                            rd and rd["glyph"], ld, ri is not None, now["ids"], now["sessions"]))
        run.step("sidepane-status", s_sidepane_status, needs=("agent-status",))

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

        # -- 8c. T08: keyboard layer against real herdr ----------------------
        # After reconnect on purpose: these steps add a pane and a session,
        # and reconnect asserts the 2-pane / 1-session shape.
        def terminal_keys():
            """Hand the keyboard to the terminal (hwkb mode, nothing focused)."""
            run.page.evaluate("() => { const a = document.activeElement;"
                              " if (a && a !== document.body) a.blur(); }")
            if not run.page.evaluate("() => terminalHasKeyboardFocus()"):
                raise RuntimeError("terminal does not have keyboard focus (hwkb off?)")

        def pane_text(h, pane):
            return h.cli("pane", "read", pane, "--source", "visible")

        # Focus reporting (CSI ?1004h). herdr itself asks for it (the client's
        # mouse.focus); a probe in the SHELL pane asks herdr in turn and prints
        # every input chunk with ESC as ^[. Page blur / focus must reach the
        # pane as ^[[O / ^[[I -- read back through herdr, not the client.
        # Window focus/blur are dispatched as events: headless WebKit has no
        # OS window to defocus.
        FOCUS_PROBE = (
            "process.stdout.write('\\x1b[?1004h');\n"
            "if (process.stdin.isTTY) process.stdin.setRawMode(true);\n"
            "process.stdout.write('PROBE READY\\r\\n');\n"
            "process.stdin.on('data', d => {\n"
            "  const s = d.toString('latin1');\n"
            "  process.stdout.write('GOT ' + s.replace(/\\x1b/g, '^[') + '\\r\\n');\n"
            "  if (s.includes('q')) { process.stdout.write('\\x1b[?1004l'); process.exit(0); }\n"
            "});\n")

        def s_focus_report():
            h = st["herdr"]
            shell = st["new_pane"]
            focused, _ = h.layout()
            if focused != shell:
                return False, "shell pane %s not focused (%s); not typing" % (shell, focused)
            g = grid(run.page)
            if not (g["mouse"] or {}).get("focus"):
                return False, "client never learned herdr asked for ?1004h: %s" % (g["mouse"],)
            work = os.path.join(os.path.dirname(args.audit_log), "work")
            with open(os.path.join(work, "focus-probe.js"), "w", encoding="utf-8") as f:
                f.write(FOCUS_PROBE)
            terminal_keys()
            run.page.keyboard.type("node focus-probe.js")
            run.page.keyboard.press("Enter")
            end = time.time() + 15
            while time.time() < end and "PROBE READY" not in pane_text(h, shell):
                time.sleep(0.3)
            before = pane_text(h, shell)
            if "PROBE READY" not in before:
                return False, "probe never started: %r" % before[-200:]
            n0 = before.count("GOT ")
            run.page.evaluate("() => window.dispatchEvent(new Event('blur'))")
            time.sleep(1.5)
            run.page.evaluate("() => window.dispatchEvent(new Event('focus'))")
            end = time.time() + 5
            txt = pane_text(h, shell)
            while time.time() < end and txt.count("GOT ") < n0 + 2:
                time.sleep(0.3)
                txt = pane_text(h, shell)
            got = re.findall(r"GOT (\S+)", txt[txt.index("PROBE READY"):])
            run.page.keyboard.press("q")   # probe exits and turns ?1004 back off
            time.sleep(0.8)
            ok = got[-2:] == ["^[[O", "^[[I"]
            return ok, "client mouse=%s; probe in shell pane %s received %s after blur, focus" % (
                g["mouse"], shell, got)
        run.step("focus-report", s_focus_report, needs=("typed-echo",))

        # ctrl+b v typed into the WEB client must split the herdr pane: the
        # prefix is held, then released to herdr as \x02v in one write.
        def s_prefix_passthrough():
            h = st["herdr"]
            _, panes0 = h.layout()
            terminal_keys()
            run.page.keyboard.press("Control+b")
            chip = run.page.evaluate("() => kbPrefixArmed && document.getElementById('kb-chip').textContent")
            run.page.keyboard.press("v")
            end = time.time() + 8
            panes = panes0
            while time.time() < end and len(panes) == len(panes0):
                time.sleep(0.3)
                _, panes = h.layout()
            return len(panes) == len(panes0) + 1, "chip %r; herdr panes %d -> %d after ctrl+b v" % (
                chip, len(panes0), len(panes))
        run.step("prefix-passthrough", s_prefix_passthrough, needs=("tap-focus",))

        # A second session made through the UI; ctrl+b n moves in side-pane
        # order; ctrl+b a jumps to the session needing attention. The oracle is
        # computed HERE from the statuses the server sent, not by the client.
        RANK = {"blocked": 0, "done": 1, "working": 2, "idle": 3, "unknown": 4}

        def statuses():
            return run.page.evaluate("() => sessionList.map(s => [s.id, sessionStatus(s)])")

        def side_order(sts):
            return [sid for _, (sid, stt) in sorted(enumerate(sts), key=lambda p: (RANK[p[1][1]], p[0]))]

        def s_session_switch():
            sid = st["sid"]
            n0 = len(grid(run.page)["sessions"])
            run.page.click("#new-btn")
            ok, g = wait_grid(run.page, lambda g: len(g["sessions"]) == n0 + 1 and g["active"] not in (None, sid), 30)
            if not ok:
                return False, "new session never appeared/activated: %s active=%s" % (g["sessions"], g["active"])
            new = g["active"]
            notes = ["created session %s via #new-btn" % new]
            # n: next in side-pane order
            sts = statuses()
            order = side_order(sts)
            want = order[(order.index(new) + 1) % len(order)]
            terminal_keys()
            run.page.keyboard.press("Control+b")
            run.page.keyboard.press("n")
            ok_n, g = wait_grid(run.page, lambda g: g["active"] == want, 5)
            notes.append("statuses %s, order %s: ctrl+b n %s -> %s (want %s)" % (sts, order, new, g["active"], want))
            # a: make session `sid` finish unseen (Claude answers while we look
            # at the other one), then jump to it.
            run.page.evaluate("(id) => selectSession(id)", new)
            wait_grid(run.page, lambda g: g["active"] == new, 5)
            ok_a = False
            pane = st.get("claude_pane")
            if pane and st.get("herdr_agent"):
                st["herdr_agent"].cli("agent", "prompt", pane, "Reply with the single word OK. Do nothing else.")
                end = time.time() + 120
                while time.time() < end and dict(statuses()).get(sid) != "done":
                    time.sleep(0.5)
                sts = statuses()
                q = [i for i in side_order(sts) if dict(sts)[i] in ("blocked", "done")]
                want_a = (q[(q.index(new) + 1) % len(q)] if new in q else q[0]) if q else None
                terminal_keys()
                run.page.keyboard.press("Control+b")
                run.page.keyboard.press("a")
                ok_a, g = wait_grid(run.page, lambda g: g["active"] == want_a, 5)
                ok_a = ok_a and want_a == sid
                notes.append("after prompting session %s: statuses %s; ctrl+b a -> %s (want %s, the unseen finish)"
                             % (sid, sts, g["active"], want_a))
            else:
                notes.append("no claude pane from agent-status; ctrl+b a not exercised live")
            return ok_n and ok_a, "; ".join(notes)
        run.step("session-switch", s_session_switch, needs=("existing-screen",))

        # -- 8b. herdr restart: the status feed resumes (T06) --------------
        # Runs the REAL lib/herdr-events.js feed against a REAL herdr server
        # for a separate throwaway session (<prefix>-90), stops and restarts
        # that server, and requires the feed to go down and come back on a new
        # subscription -- then starts Claude in the restored pane and requires
        # that agent to arrive through the resumed subscription.
        #
        # Why not restart <prefix>-0 under the client: on herdr 0.8.2/Windows a
        # server stop kills the pane processes (no live handoff), the attached
        # pty client exits, and server.js onExit -> backend.state() reads the
        # stopped record as 'stale' and DELETES it (heal-on-read). Measured on
        # the first run of this step: audit "Stopped herdr session removed:
        # cmsim-0", the session left the client, and the relaunch lost the
        # race. That is session lifecycle, not the feed; see the T06 report.
        def s_herdr_restart():
            name = "%s-90" % args.prefix
            r = subprocess.run(["node", os.path.join(HERE, "herdr-events-live.js"), "--session", name,
                                "--prefix", args.prefix, "--config", herdr_config,
                                "--cwd", os.path.join(os.path.dirname(args.audit_log), "work"),
                                "--start-claude"],
                               capture_output=True, text=True, timeout=180)
            out = (r.stdout or "").strip().splitlines()
            try:
                ev = json.loads(out[-1])
            except (ValueError, IndexError):
                return False, "driver gave no JSON (exit %s): %s" % (r.returncode, (r.stderr or "")[-300:])
            return r.returncode == 0 and ev.get("ok") is True, (
                "%s: feed %s -> %s during restart (server down %sms) -> resumed=%s %sms after herdr was "
                "back, reconnects=%s; claude started after restart reached the feed=%s in %sms %s; "
                "transitions %s; leftover session=%s%s" % (
                    name, ev.get("before"), (ev.get("duringRestart") or {}).get("feed"),
                    ev.get("serverDownMs"), ev.get("resumed"), ev.get("resumeAfterServerUpMs"),
                    ev.get("reconnects"), ev.get("agentAfterRestart"), ev.get("agentDetectMs"),
                    ev.get("agentView"), ev.get("transitions"), ev.get("leftover"),
                    (" ERROR " + ev["error"]) if ev.get("error") else ""))
        run.step("herdr-restart", s_herdr_restart, needs=("live-before",))

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
