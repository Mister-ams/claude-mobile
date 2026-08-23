"""
Live verification of the server controls, driven through the real client.

Restarting the server from the client is the kind of feature that looks fine
in code review and fails in the one way that matters: the process does not
come back, or it comes back without the sessions, or it restarts somebody
else's process. So this drives the actual buttons against a running instance
and checks the server on the other side.

The pm2Name assertion is the important one. update.sh restarts by name, the
name used to be hardcoded to "claude-mobile", and its guard matched that as a
SUBSTRING -- so an update triggered from a second instance restarted the LIVE
server instead of itself. If this reports the wrong name, that bug is back.

Run:
  python.exe test/server-control-verify.py --port 3459 --totp-secret <base32>
  ... --expect-pm2 claude-mobile-ctl   the PM2 process this instance IS
  ... --update                          also exercise the update flow (slow)
  ... --out <dir>                       where PNGs land
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

# Python defaults to cp1252 on this box; the console dies on any non-ASCII the
# client happens to render. Never let the harness fail for a reason the code
# under test does not have.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from playwright.sync_api import sync_playwright


def totp(s, period=30, digits=6):
    key = base64.b32decode(s.strip().upper() + "=" * (-len(s.strip()) % 8))
    mac = hmac.new(key, struct.pack(">Q", int(time.time() // period)), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return str((struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)).zfill(digits)


def login(page, base, secret):
    page.goto(base + "/", wait_until="load")
    page.wait_for_selector("#auth-screen", state="visible", timeout=15000)
    page.wait_for_timeout(600)
    if time.time() % 30 > 27:
        time.sleep(4)
    page.fill("#totp-input", totp(secret))
    page.click("#auth-submit-btn")
    page.wait_for_function(
        "() => document.getElementById('app').classList.contains('shown')", timeout=20000)
    page.wait_for_timeout(1200)


# The page already holds a session token, so ask it to make the call rather
# than reimplementing auth here.
STATUS_JS = """async () => {
  const r = await fetch('/api/server/status', { headers: { 'X-Session-Token': sessionToken } });
  return r.ok ? await r.json() : { error: r.status };
}"""

# Liveness has to be asked UNAUTHENTICATED. Session tokens live in an in-memory
# Map, so a restart invalidates every one of them -- polling an authenticated
# route after a restart can never succeed, and reads as "the server never came
# back" when it came back fine. That is exactly what this harness got wrong the
# first time.
HEALTH_JS = """async () => {
  try { const r = await fetch('/health'); return r.ok ? await r.json() : null; }
  catch (e) { return null; }
}"""

# Whether the client is still signed in, which a restart decides for us.
AUTHED_JS = """() => ({
  appShown: document.getElementById('app').classList.contains('shown'),
  authVisible: getComputedStyle(document.getElementById('auth-screen')).display !== 'none',
})"""


def open_settings(page):
    page.click("#settings-btn")
    page.wait_for_timeout(1500)


def panel_text(page):
    return page.evaluate("""() => ({
      version: document.getElementById('srv-version').textContent,
      note: document.getElementById('srv-note').textContent,
      result: document.getElementById('srv-result').textContent,
      updateDisabled: document.getElementById('srv-update').disabled,
      restartLabel: document.getElementById('srv-restart').textContent,
    })""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3459)
    ap.add_argument("--totp-secret", required=True)
    ap.add_argument("--expect-pm2", default=None)
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--out", default=os.path.join(os.environ.get("TEMP", "/tmp"), "cm-ctl"))
    args = ap.parse_args()

    base = "http://localhost:%d" % args.port
    os.makedirs(args.out, exist_ok=True)
    failures = []

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1366, "height": 1024}, device_scale_factor=2)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("dialog", lambda d: d.accept())

        login(page, base, args.totp_secret)
        print("authenticated on %s" % base)

        # A session to lose, so "it restarted" and "it restarted and kept my
        # work" are different observations.
        if page.evaluate("() => (sessionList || []).length") == 0:
            page.evaluate("() => newSession()")
            page.wait_for_function("() => (sessionList || []).length > 0", timeout=40000)
            page.wait_for_timeout(6000)
        before = page.evaluate("() => (sessionList || []).map(s => s.id + '|' + s.name).sort()")
        print("sessions before: %s" % before)

        open_settings(page)
        st = page.evaluate(STATUS_JS)
        txt = panel_text(page)
        print("\npanel   version=%r note=%r" % (txt["version"], txt["note"]))
        print("status  pm2=%s commit=%s remote=%s available=%s"
              % (st.get("pm2Name"), st.get("commit"),
                 (st.get("remote") or {}).get("commit"), st.get("updateAvailable")))
        page.screenshot(path=os.path.join(args.out, "panel.png"))

        if args.expect_pm2 and st.get("pm2Name") != args.expect_pm2:
            failures.append("pm2Name is %r, expected %r -- an update would restart the WRONG process"
                            % (st.get("pm2Name"), args.expect_pm2))
        if not txt["version"].startswith("v"):
            failures.append("panel did not render a version: %r" % txt["version"])

        # ── restart, through the actual button ──────────────────────
        print("\n=== restart ===")
        page.click("#srv-restart")
        page.wait_for_timeout(300)
        armed = page.evaluate("() => document.getElementById('srv-restart').textContent")
        if armed != "Confirm?":
            failures.append("first tap did not arm the button (label %r)" % armed)
        else:
            print("   first tap armed it")
        page.click("#srv-restart")
        print("   confirmed; waiting for the server to come back...")

        back = None
        for _ in range(40):
            page.wait_for_timeout(1500)
            h = page.evaluate(HEALTH_JS)
            if h and h.get("status"):
                back = h
                break
        if not back:
            failures.append("server did not come back after restart")
        else:
            print("   back up: uptime=%ss sessions=%s backend=%s"
                  % (back.get("uptime"), back.get("sessions"), back.get("backend")))
            if back.get("sessions") != len(before):
                failures.append("server came back with %s sessions, had %d before"
                                % (back.get("sessions"), len(before)))

            # A restart wipes the in-memory token map, so the client is signed
            # out. Recorded rather than asserted: it is the product's current
            # behaviour, and the UI is expected to say so BEFORE the tap.
            page.wait_for_timeout(9000)
            authed = page.evaluate(AUTHED_JS)
            print("   client still signed in: %s" % (not authed["authVisible"]))

            # The client's own liveness poll must notice. It used to ask an
            # AUTHENTICATED route, which 401s forever once the token dies with
            # the restart -- so it timed out into a false alarm about a server
            # that had already come back.
            result = page.evaluate("() => document.getElementById('srv-result').textContent")
            print("   panel says: %r" % result)
            if "taking longer than expected" in result:
                failures.append("client reported a false timeout after a successful restart")

            # Re-authenticate to confirm the session is really still there,
            # rather than trusting the /health count alone.
            login(page, base, args.totp_secret)
            page.wait_for_timeout(2000)
            after = page.evaluate("() => (sessionList || []).map(s => s.id + '|' + s.name).sort()")
            print("   sessions after: %s" % after)
            if after != before:
                failures.append("sessions changed across the restart: %s -> %s" % (before, after))

        # ── update, if asked ────────────────────────────────────────
        if args.update:
            print("\n=== update ===")
            page.reload(wait_until="load")
            login(page, base, args.totp_secret)
            open_settings(page)
            page.evaluate("() => document.getElementById('srv-update').disabled = false")
            page.click("#srv-update")
            page.wait_for_timeout(300)
            page.click("#srv-update")
            print("   confirmed; waiting for update.sh to finish and restart...")
            # Same trap as the restart poll, and it caught me twice: the update
            # ends by restarting the server, which invalidates this client's
            # token. Wait for liveness UNAUTHENTICATED, then sign in again
            # before asking an authenticated route anything.
            done = None
            for _ in range(80):
                page.wait_for_timeout(3000)
                h = page.evaluate(HEALTH_JS)
                if not (h and h.get("status")):
                    continue          # mid-restart
                try:
                    login(page, base, args.totp_secret)
                    open_settings(page)
                except Exception:
                    continue          # came back between the two calls
                s = page.evaluate(STATUS_JS)
                if s and not s.get("error") and not s.get("updateRunning") and s.get("lastUpdate"):
                    done = s["lastUpdate"]
                    break
            if not done:
                failures.append("update never reported a result")
            else:
                print("   result: from=%s to=%s exit=%s changed=%s error=%s"
                      % (done.get("from"), done.get("to"), done.get("exitCode"),
                         done.get("changed"), done.get("error")))
                if done.get("exitCode") != 0:
                    failures.append("update exited %s (update.sh reports DEGRADED as non-zero)"
                                    % done.get("exitCode"))
                after = page.evaluate("() => (sessionList || []).map(s => s.id + '|' + s.name).sort()")
                if after != before:
                    failures.append("sessions changed across the update: %s -> %s" % (before, after))
                page.screenshot(path=os.path.join(args.out, "after-update.png"))

        if errs:
            failures.append("%d page errors: %s" % (len(errs), errs[:2]))
        b.close()

    print()
    if failures:
        print("FAILURES (%d):" % len(failures))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("PASS: server controls work from the client and the sessions survive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
