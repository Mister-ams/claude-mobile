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

  herdr exposes `viewport_rows` on a pane and no column count, so rows are
  read directly and columns are inferred from the widest painted row. Claude
  draws full-width rules and boxes, so that tracks the pane width closely --
  and the two orientations differ by tens of columns, far more than the proxy's
  error.

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
    """(pane_id, viewport_rows, widest painted row) straight from herdr."""
    out = cli(["pane", "list"])
    i = out.find('"pane_id":"')
    if i < 0:
        return None, None, None
    pid = out[i + 11:out.find('"', i + 11)]

    rows = None
    j = out.find('"viewport_rows":')
    if j >= 0:
        k = j + len('"viewport_rows":')
        digits = ""
        while k < len(out) and out[k].isdigit():
            digits += out[k]
            k += 1
        rows = int(digits) if digits else None

    read = cli(["pane", "read", pid, "--source", "visible", "--lines", "60"])
    try:
        text = json.loads(read).get("result", {}).get("text", read)
    except Exception:
        text = read
    widths = [len(l.rstrip()) for l in text.splitlines()]
    return pid, rows, (max(widths) if widths else None)


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

        print("  %-11s %-13s %-14s %s" % ("step", "mirror", "herdr rows", "painted cols"))
        for label, w, h in STEPS:
            page.set_viewport_size({"width": w, "height": h})
            page.wait_for_timeout(5000)
            g = page.evaluate("""() => {
              const g = gridTerms[activeSession];
              return g ? { cols: g.cols, rows: g.rows } : null;
            }""")
            _, rows, width = pane_geometry(cli)
            rows_out.append((label, g, rows, width))
            print("  %-11s %-13s %-14s %s"
                  % (label, "%sx%s" % (g["cols"], g["rows"]) if g else "?", rows, width))
        b.close()

    print()
    failures = []
    for label, g, rows, width in rows_out:
        if g is None or rows is None or width is None:
            failures.append("%s: could not read the pane" % label)
            continue
        # herdr spends a row or two on chrome, and the painted-width proxy is
        # only as wide as Claude's widest rule -- so a few columns of slack.
        # A pane stuck in the other orientation is 16 columns out, not 3.
        if abs(rows - g["rows"]) > 4:
            failures.append("%s: herdr pane is %d rows, mirror is %d -- the resize did not land"
                            % (label, rows, g["rows"]))
        if abs(width - g["cols"]) > 4:
            failures.append("%s: widest painted row is %d cols, mirror is %d -- Claude did not reflow"
                            % (label, width, g["cols"]))

    if failures:
        print("FAILURES (%d):" % len(failures))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("PASS: the herdr pane and Claude follow the client through rotation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
