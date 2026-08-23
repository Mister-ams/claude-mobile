"""
Live end-to-end verification against a RUNNING claude-mobile server.

test/ipad-emulator.py drives a static server with synthetic frames -- it never
touches a session backend, so it cannot tell you whether dtach or herdr
actually works. This does the opposite: it authenticates for real, creates a
real session, waits for Claude to paint in it, and measures what the client
receives at real iPad and phone viewports.

Backend-agnostic on purpose. Point it at 3456 and it exercises dtach; point it
at 3457 and it exercises herdr. The point of the seam is that this script
cannot tell the difference.

Run:
  python.exe test/live-session-verify.py --port 3457 --totp-secret <base32>
  ... --out <dir>        where PNGs land
  ... --recover-only     skip creation, just verify existing sessions recover
  ... --keep             leave the session running (default: leave it running)

The TOTP secret is the one the target instance minted for itself. Never pass
the operator's.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import struct
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))

VIEWPORTS = [
    ("ipad11-landscape", 1194, 834),
    ("ipad11-portrait", 834, 1194),
    ("ipad13-landscape", 1366, 1024),
    ("phone", 390, 844),
]


def totp(secret_b32, when=None, period=30, digits=6):
    """RFC 6238, so the harness needs no TOTP dependency of its own."""
    key = base64.b32decode(secret_b32.strip().replace(" ", "").upper() + "=" * (-len(secret_b32) % 8))
    counter = int((when or time.time()) // period)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


# What the client actually got: terminal area, grid geometry, and the text on
# screen. Every number is read from the running page, never computed here.
MEASURE = """() => {
  const wrap = document.querySelector('.term-wrap') || document.querySelector('.grid-term');
  const grid = document.querySelector('.grid-term') || wrap;
  const r = wrap ? wrap.getBoundingClientRect() : null;
  const row = document.querySelector('.grid-row');
  const rowH = row ? row.getBoundingClientRect().height : 0;
  const probe = document.createElement('span');
  if (grid) {
    probe.textContent = '0'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    grid.appendChild(probe);
  }
  const charW = probe.getBoundingClientRect().width / 100 || 0;
  if (probe.parentNode) probe.remove();
  const rows = [...document.querySelectorAll('.grid-row')];
  const text = rows.map(el => el.innerText).join('\\n');
  return {
    viewport: { w: innerWidth, h: innerHeight },
    terminal: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
    terminalPct: r ? Math.round(r.height / innerHeight * 100) : null,
    cols: charW ? Math.floor((r ? r.width : 0) / charW) : 0,
    rows: rowH ? Math.floor((r ? r.height : 0) / rowH) : 0,
    gridRows: rows.length,
    nonEmptyRows: rows.filter(el => el.innerText.trim()).length,
    textLen: text.length,
    sample: text.slice(0, 400),
    sessions: (typeof sessionList !== 'undefined' && sessionList) ? sessionList.length : null,
    activeSession: (typeof activeSession !== 'undefined') ? activeSession : null
  };
}"""


def login(page, base, secret, errs):
    page.goto(base + "/", wait_until="load")
    page.wait_for_selector("#auth-screen", state="visible", timeout=15000)
    page.wait_for_timeout(600)
    # A code minted in the last second of its window expires mid-flight; the
    # next one is always safe to wait for.
    if time.time() % 30 > 27:
        time.sleep(4)
    page.fill("#totp-input", totp(secret))
    page.click("#auth-submit-btn")
    try:
        page.wait_for_function("() => document.getElementById('app').classList.contains('shown')",
                               timeout=20000)
    except Exception as e:
        errs.append("login did not reach the app: %s" % str(e)[:160])
        return False
    page.wait_for_timeout(800)
    return True


def wait_for_claude(page, timeout_s):
    """Claude has painted when its own text shows up in the grid."""
    end = time.time() + timeout_s
    marker = None
    while time.time() < end:
        m = page.evaluate("""() => {
          const t = [...document.querySelectorAll('.grid-row')].map(e => e.innerText).join('\\n');
          if (/Welcome to Claude Code/i.test(t)) return 'welcome-banner';
          if (/claude\\.ai\\/code|Claude Code v/i.test(t)) return 'claude-banner';
          if (/\\bcwd:/i.test(t) && /claude/i.test(t)) return 'claude-cwd';
          if (/esc to interrupt|Cogitating|\\? for shortcuts/i.test(t)) return 'claude-tui';
          return null;
        }""")
        if m:
            marker = m
            break
        page.wait_for_timeout(1000)
    return marker


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3457)
    ap.add_argument("--totp-secret", required=True)
    ap.add_argument("--out", default=os.path.join(os.environ.get("TEMP", "/tmp"), "cm-live"))
    ap.add_argument("--recover-only", action="store_true")
    ap.add_argument("--claude-timeout", type=int, default=90)
    args = ap.parse_args()

    base = "http://localhost:%d" % args.port
    os.makedirs(args.out, exist_ok=True)

    report = {"port": args.port, "viewports": {}}
    failures = []

    with sync_playwright() as p:
        b = p.chromium.launch()

        # ── pass 1: create (or find) a session and wait for Claude ──
        ctx = b.new_context(viewport={"width": 1194, "height": 834}, device_scale_factor=2)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("dialog", lambda d: d.accept())

        if not login(page, base, args.totp_secret, errs):
            print("FAIL: could not authenticate")
            for e in errs[:5]:
                print("   pageerror %s" % e[:200])
            b.close()
            return 1
        print("authenticated on %s" % base)

        existing = page.evaluate("() => (sessionList || []).length")
        print("sessions already present: %d" % existing)

        if args.recover_only:
            if existing == 0:
                failures.append("recover-only: no sessions recovered after restart")
        elif existing == 0:
            page.evaluate("() => newSession()")
            print("create sent; waiting for the session to appear...")
            try:
                page.wait_for_function("() => (sessionList || []).length > 0", timeout=40000)
            except Exception as e:
                failures.append("session never appeared: %s" % str(e)[:160])
            else:
                print("session created (%d in list)" % page.evaluate("() => sessionList.length"))

        marker = wait_for_claude(page, args.claude_timeout)
        if marker:
            print("Claude is up in the pane: %s" % marker)
        else:
            failures.append("Claude did not paint within %ds" % args.claude_timeout)
            snap = page.evaluate("""() => [...document.querySelectorAll('.grid-row')]
                                        .map(e => e.innerText).join('\\n').slice(-1200)""")
            print("--- last grid content ---\n%s\n-------------------------" % snap)
        report["claudeMarker"] = marker
        ctx.close()

        # ── pass 2: measure every viewport against the live session ──
        for name, w, h in VIEWPORTS:
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2)
            page = ctx.new_page()
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.on("dialog", lambda d: d.accept())

            if not login(page, base, args.totp_secret, errs):
                failures.append("%s: login failed" % name)
                ctx.close()
                continue
            # The client sizes the pty to ITS width on attach; give the server a
            # beat to resize and push a fresh snapshot before measuring.
            page.wait_for_timeout(4000)

            m = page.evaluate(MEASURE)
            shot = os.path.join(args.out, "%s.png" % name)
            page.screenshot(path=shot)
            report["viewports"][name] = {"metrics": m, "screenshot": shot, "pageerrors": errs[:3]}

            print("%-18s %dx%d" % (name, w, h))
            print("   terminal   %sx%s px (%s%% of height)" % (
                m["terminal"]["w"] if m["terminal"] else "-",
                m["terminal"]["h"] if m["terminal"] else "-", m["terminalPct"]))
            print("   grid       %s cols x %s rows   rows painted %s/%s" % (
                m["cols"], m["rows"], m["nonEmptyRows"], m["gridRows"]))
            print("   content    %d chars, sessions=%s active=%s" % (
                m["textLen"], m["sessions"], m["activeSession"]))
            print("   shot       %s" % shot)
            if errs:
                print("   pageerrors %s" % errs[:2])
                failures.append("%s: %d page errors" % (name, len(errs)))
            if m["nonEmptyRows"] == 0:
                failures.append("%s: terminal rendered nothing" % name)
            print()
            ctx.close()
        b.close()

    with open(os.path.join(args.out, "live-metrics.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("metrics -> %s" % os.path.join(args.out, "live-metrics.json"))

    if failures:
        print("\nFAILURES (%d):" % len(failures))
        for f_ in failures:
            print("  - %s" % f_)
        return 1
    print("\nPASS: all %d viewports rendered a live session" % len(VIEWPORTS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
