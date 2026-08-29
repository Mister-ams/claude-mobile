#!/usr/bin/env python3
"""T22 -- does a tap in the BROWSER reach the herdr pane?

test/t22-mouse-verify.js proves the encoding and proves that the bytes, once
written to the pty, move focus. It says nothing about the half that runs on
the iPad: pointer event -> cell -> WebSocket -> server. That half is where a
mouse feature usually fails, because an off-by-one in the pixel-to-cell
mapping still looks like a working click.

So this drives a REAL browser against a REAL server on the herdr backend,
splits the pane behind the client's back, taps the OTHER pane in the page, and
asserts herdr's own focused_pane_id moved. Nothing is computed twice: the cell
comes from the page's own geometry, and the verdict comes from herdr.

A control tap on the ALREADY-focused pane runs first: it must NOT move focus.
Without it, a pass could just be herdr focusing whatever was clicked last.

  python.exe test/t22-client-click-verify.py --port 3458 \
      --totp-secret <base32> --herdr-session cmt-0

Needs playwright (chromium) and herdr on PATH or HERDR_BIN.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERDR = os.environ.get("HERDR_BIN") or os.path.expanduser(
    r"~\tools\herdr\herdr.exe")


def totp(secret_b32, when=None, period=30, digits=6):
    """RFC 6238, so the harness needs no TOTP dependency of its own."""
    key = base64.b32decode(
        secret_b32.strip().replace(" ", "").upper() + "=" * (-len(secret_b32) % 8))
    counter = int((when or time.time()) // period)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def health(port, timeout=40):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            with urllib.request.urlopen(
                    "http://localhost:%d/health" % port, timeout=3) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(0.5)
    raise RuntimeError("server on %d never answered /health: %s" % (port, last))


def login(page, base, secret, errs):
    page.goto(base + "/", wait_until="load")
    page.wait_for_selector("#auth-screen", state="visible", timeout=15000)
    page.wait_for_timeout(600)
    # A code minted in the last second of its window expires mid-flight.
    if time.time() % 30 > 27:
        time.sleep(4)
    page.fill("#totp-input", totp(secret))
    page.click("#auth-submit-btn")
    try:
        page.wait_for_function(
            "() => document.getElementById('app').classList.contains('shown')",
            timeout=20000)
    except Exception as e:
        errs.append("login did not reach the app: %s" % str(e)[:160])
        return False
    page.wait_for_timeout(1200)
    return True


class Herdr:
    def __init__(self, session, config):
        self.env = dict(os.environ)
        self.env["HERDR_SESSION"] = session
        self.env["HERDR_CONFIG_PATH"] = config

    def cli(self, *args):
        return subprocess.run([HERDR, *args], capture_output=True, text=True,
                              env=self.env, timeout=25).stdout.strip()

    def snapshot(self):
        return json.loads(self.cli("api", "snapshot"))["result"]["snapshot"]


# The page's own geometry, so the harness never re-derives what the client
# already knows. charWidth comes off the live grid object -- the same number
# the client's own pointer mapping uses -- rather than being measured again
# here, because a second measurement could agree with the screen while
# disagreeing with the code under test.
CELL_TO_PIXEL = """([col, row]) => {
  const grid = (typeof gridTerms !== 'undefined' && typeof activeSession !== 'undefined')
    ? gridTerms[activeSession] : null;
  if (!grid) return { err: 'no grid for the active session' };
  const el = grid.rowEls.get(row - 1);
  if (!el) return { err: 'server row ' + (row - 1) + ' is not mounted' };
  const charW = (typeof measureCharWidth === 'function') ? measureCharWidth(grid) : grid.charWidth;
  if (!charW) return { err: 'char width unmeasurable' };
  const r = el.getBoundingClientRect();
  return {
    x: r.left + (col - 0.5) * charW,
    y: r.top + r.height / 2,
    charW, mouse: grid.mouse, cols: grid.cols, rows: grid.rows,
  };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--totp-secret", required=True)
    ap.add_argument("--herdr-session", required=True)
    ap.add_argument("--herdr-config", default=os.path.join(
        os.path.dirname(__file__), "..", "herdr-config.toml"))
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    base = "http://localhost:%d" % args.port
    errs = []
    checks = []

    def check(name, cond, detail=""):
        checks.append((bool(cond), name, detail))
        print("  %s  %s%s" % ("PASS" if cond else "FAIL", name,
                              ("  " + str(detail)) if detail else ""))

    h = health(args.port)
    check("server is up on the herdr backend", h.get("backend") == "herdr",
          "backend=%s sessions=%s" % (h.get("backend"), h.get("sessions")))

    herdr = Herdr(args.herdr_session, os.path.abspath(args.herdr_config))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        # iPad 11 landscape -- the target device, and the geometry the cell
        # mapping has to be right at.
        ctx = browser.new_context(viewport={"width": 1194, "height": 834},
                                  device_scale_factor=2, has_touch=True)
        page = ctx.new_page()
        # TOFU pins the server key behind a native confirm() on first connect.
        # Headless auto-DISMISSES a dialog, which closes the socket and reads as
        # an auth failure -- every other harness in this directory accepts it.
        page.on("dialog", lambda d: d.accept())
        page.on("pageerror", lambda e: errs.append("pageerror: %s" % str(e)[:200]))

        if not login(page, base, args.totp_secret, errs):
            print("\n".join(errs))
            return 1
        check("logged in and the app is showing", True)

        # Wait for the grid to carry content AND for the server to have told
        # us the app wants mouse. The second is the thing T22 added; without
        # it the client deliberately stays out of the way.
        deadline = time.time() + 45
        state = None
        while time.time() < deadline:
            state = page.evaluate(
                """() => {
                  const g = (typeof gridTerms !== 'undefined' && typeof activeSession !== 'undefined')
                    ? gridTerms[activeSession] : null;
                  return g ? { mouse: g.mouse, rows: g.rowEls.size, cols: g.cols } : null;
                }""")
            if state and state["rows"] > 0 and state["mouse"]["tracking"] != "none":
                break
            page.wait_for_timeout(1000)

        check("client learned the app wants mouse",
              bool(state) and state["mouse"]["tracking"] != "none",
              state and json.dumps(state["mouse"]))
        check("client learned the SGR encoding",
              bool(state) and state["mouse"]["encoding"] == "sgr",
              state and state["mouse"].get("encoding"))
        check("the pane's touches are surrendered to the app",
              page.evaluate("""() => {
                const w = document.querySelector('.term-wrap.active .grid-term') ||
                          document.querySelector('.grid-term');
                return !!w && w.classList.contains('mouse-active');
              }"""))

        if not state or state["mouse"]["tracking"] == "none":
            print("\nmouse never became active; nothing further can be tested")
            return 1

        # A captured drag is the gesture herdr uses to resize a split, and it
        # is where the element-based mapping failed: setPointerCapture
        # retargets every subsequent event to the wrap, so e.target is no
        # longer a .grid-row and closest() returns null for the whole drag.
        # This asserts the shipped mapping resolves that case AND that the
        # element-based one does not -- the failure is demonstrated in place
        # rather than asserted to have happened once.
        drag = page.evaluate("""() => {
          const g = gridTerms[activeSession];
          const r = g.wrap.getBoundingClientRect();
          // Exactly what the browser delivers mid-drag under pointer capture.
          const midDrag = { target: g.wrap, clientX: r.left + 40, clientY: r.top + 40 };
          const now = gridCellFromEvent(g, midDrag);
          // The element-based predecessor, for contrast.
          const beforeFix = (() => {
            const el = midDrag.target.closest ? midDrag.target.closest('.grid-row') : null;
            return el ? 'resolved' : null;
          })();
          return { now, beforeFix };
        }""")
        check("a captured drag resolves a cell", bool(drag["now"]),
              json.dumps(drag["now"]))
        check("and the element-based mapping could not have",
              drag["beforeFix"] is None,
              "closest('.grid-row') -> %s" % drag["beforeFix"])

        # Split behind the client's back, so the pane it renders genuinely
        # has two halves to aim between.
        herdr.cli("pane", "split", "w1:p1", "--direction", "right")
        page.wait_for_timeout(2500)

        snap = herdr.snapshot()
        layout = (snap.get("layouts") or [None])[0]
        if not layout or len(layout["panes"]) < 2:
            check("split produced a second pane", False,
                  "got %d" % (len(layout["panes"]) if layout else 0))
            return 1
        check("split produced a second pane", True, "%d panes" % len(layout["panes"]))

        before = snap["focused_pane_id"]
        target = next(p_ for p_ in layout["panes"] if p_["pane_id"] != before)
        home = next(p_ for p_ in layout["panes"] if p_["pane_id"] == before)

        # CONTROL: tapping the pane that is ALREADY focused must not move
        # focus. If this "passes" by moving, the real assertion below proves
        # nothing about aiming.
        hr = home["rect"]
        pos = page.evaluate(CELL_TO_PIXEL, [hr["x"] + max(1, hr["width"] // 2),
                                            hr["y"] + max(1, hr["height"] // 2)])
        if "err" in pos:
            check("control tap could be located", False, pos["err"])
        else:
            page.mouse.click(pos["x"], pos["y"])
            page.wait_for_timeout(2000)
            check("control: tapping the focused pane leaves focus alone",
                  herdr.snapshot()["focused_pane_id"] == before)

        # THE ASSERTION. Aim at the middle of the other pane, in the page.
        tr = target["rect"]
        col = tr["x"] + max(1, tr["width"] // 2)
        row = tr["y"] + max(1, tr["height"] // 2)
        pos = page.evaluate(CELL_TO_PIXEL, [col, row])
        if "err" in pos:
            check("target cell could be located in the page", False, pos["err"])
            return 1
        check("target cell could be located in the page", True,
              "cell %d,%d -> %.1f,%.1f px (charW %.2f)"
              % (col, row, pos["x"], pos["y"], pos["charW"]))

        page.mouse.click(pos["x"], pos["y"])

        moved, after = False, before
        for _ in range(40):
            page.wait_for_timeout(250)
            after = herdr.snapshot()["focused_pane_id"]
            if after != before:
                moved = True
                break
        check("A TAP IN THE BROWSER MOVED THE PANE  %s -> %s" % (before, after), moved,
              "" if moved else "focus never left %s" % before)
        check("it moved to the pane we aimed at", after == target["pane_id"],
              "wanted %s, got %s" % (target["pane_id"], after))

        browser.close()

    for e in errs:
        print("  NOTE  %s" % e)
    bad = [c for c in checks if not c[0]]
    print("\n%d passed, %d failed" % (len(checks) - len(bad), len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
