"""
Does a resize reach the herdr PANE, or only the server's mirror?

live-session-verify.py's rotation check proves the client and the server agree
on the new dimensions. That is necessary and not sufficient, and the gap is
worth stating plainly: the server resizes its own headless mirror whenever the
client asks, whether or not the backend's pane followed. A backend that
ignored resize entirely would still converge, and that test would still pass.

So this asks the far end, through herdr's own socket API, which knows nothing
about our mirror. It is herdr-specific by nature and therefore NOT part of the
backend-agnostic harness.

  Both dimensions are read EXACTLY, from `api snapshot`, whose layout carries
  a `rect` per pane. `pane get` reports only viewport_rows, and that gap is
  what made an earlier version of this infer width from the widest painted
  row -- an estimate that depended on Claude drawing a full-width rule. There
  was no need to estimate; the number was one call away.

Read-only against the pane. It deliberately does NOT `pane run` anything:
Claude is the foreground process there, so asking the shell its window size
would type a prompt into a live session instead.

Run:
  python.exe test/herdr-pane-geometry.py --port 3457 --totp-secret <base32>
  ... --session cmh-0        herdr session name (default cmh-0)
  ... --herdr <path>         herdr.exe (default C:/Users/MRAL-/tools/herdr/herdr.exe)
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

from playwright.sync_api import sync_playwright

# iPad 13, the target device. The two orientations differ by 16 columns and 10
# rows -- a pane that did not follow is unmistakable, not a judgement call.
STEPS = [
    ("landscape", 1366, 1024),
    ("portrait", 1024, 1366),
    ("landscape", 1366, 1024),
]


def totp(s, period=30, digits=6):
    key = base64.b32decode(s.strip().upper() + "=" * (-len(s.strip()) % 8))
    mac = hmac.new(key, struct.pack(">Q", int(time.time() // period)), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return str((struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)).zfill(digits)


def make_cli(herdr, session):
    def cli(args):
        r = subprocess.run(
            [herdr] + args, capture_output=True, text=True,
            # Explicit encoding: Python defaults to cp1252 on this box and
            # herdr's output is not.
            encoding="utf-8", errors="replace",
            env=dict(os.environ, HERDR_SESSION=session))
        return (r.stdout or "") + (r.stderr or "")
    return cli


def pane_geometry(cli):
    """(pane_id, exact cols, exact rows) straight from herdr's own snapshot.

    `pane get` reports viewport_rows and no column count, which is why an
    earlier version of this inferred width from the widest painted row -- a
    proxy that depended on Claude happening to draw a full-width rule. It does
    not need to: `api snapshot` carries the layout, and every pane's `rect`
    has an exact width and height. Ask for the number instead of estimating it.
    """
    raw = cli(["api", "snapshot"])
    try:
        snap = json.loads(raw)["result"]["snapshot"]
    except Exception:
        return None, None, None

    pid = snap.get("focused_pane_id")
    for layout in snap.get("layouts", []):
        for pane in layout.get("panes", []):
            if pid is None or pane.get("pane_id") == pid:
                rect = pane.get("rect") or {}
                if "width" in rect and "height" in rect:
                    return pane.get("pane_id"), rect["width"], rect["height"]
    return pid, None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3457)
    ap.add_argument("--totp-secret", required=True)
    ap.add_argument("--session", default="cmh-0")
    ap.add_argument("--herdr", default="C:/Users/MRAL-/tools/herdr/herdr.exe")
    args = ap.parse_args()

    cli = make_cli(args.herdr, args.session)
    pid, _, _ = pane_geometry(cli)
    if not pid:
        print("FAIL: no pane in herdr session %r -- is there a live session?" % args.session)
        return 1
    print("pane %s in herdr session %s\n" % (pid, args.session))

    rows_out = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": STEPS[0][1], "height": STEPS[0][2]},
                            device_scale_factor=2)
        page = ctx.new_page()
        page.on("dialog", lambda d: d.accept())
        page.goto("http://localhost:%d/" % args.port, wait_until="load")
        page.wait_for_selector("#auth-screen", state="visible", timeout=15000)
        page.wait_for_timeout(600)
        page.fill("#totp-input", totp(args.totp_secret))
        page.click("#auth-submit-btn")
        try:
            page.wait_for_function(
                "() => document.getElementById('app').classList.contains('shown')", timeout=20000)
        except Exception as e:
            print("FAIL: could not authenticate: %s" % str(e)[:160])
            b.close()
            return 1
        page.wait_for_timeout(4000)

        print("  %-11s %-13s %-13s %s" % ("step", "mirror", "herdr pane", "delta"))
        for label, w, h in STEPS:
            page.set_viewport_size({"width": w, "height": h})
            page.wait_for_timeout(5000)
            g = page.evaluate("""() => {
              const g = gridTerms[activeSession];
              return g ? { cols: g.cols, rows: g.rows } : null;
            }""")
            _, cols, rows = pane_geometry(cli)
            rows_out.append((label, g, cols, rows))
            delta = ("%+d cols, %+d rows" % (cols - g["cols"], rows - g["rows"])
                     if g and cols is not None and rows is not None else "?")
            print("  %-11s %-13s %-13s %s"
                  % (label, "%sx%s" % (g["cols"], g["rows"]) if g else "?",
                     "%sx%s" % (cols, rows), delta))
        b.close()

    print()
    failures = []
    for label, g, cols, rows in rows_out:
        if g is None or cols is None or rows is None:
            failures.append("%s: could not read the pane" % label)
            continue
        # Exact numbers on both sides now, so the tolerance is small and only
        # covers herdr spending a row or two on chrome at some widths. A pane
        # left in the other orientation is 16 columns out, not 2.
        if abs(cols - g["cols"]) > 2:
            failures.append("%s: herdr pane is %d cols, mirror is %d -- the resize did not land"
                            % (label, cols, g["cols"]))
        if abs(rows - g["rows"]) > 2:
            failures.append("%s: herdr pane is %d rows, mirror is %d -- the resize did not land"
                            % (label, rows, g["rows"]))

    if failures:
        print("FAILURES (%d):" % len(failures))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("PASS: the herdr pane and Claude follow the client through rotation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
