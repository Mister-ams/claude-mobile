#!/usr/bin/env python3
"""W6 browser-level A/B test.

Drives a Chromium tab through TOTP auth, opt-in grid mode, then forces a
WS reconnect mid-session and observes whether NEW PTY output (injected via
the side-channel Node helper) renders in the grid terminal DOM.

Patched server (port 3457) should render new output post-reconnect; the
unpatched server (port 3456) should NOT, because the line-735 reconnect
sends a `connect` without `renderer:'grid'`, the server flips that WS to
legacy mode, and subsequent grid client receives `output` messages which
its handler silently drops.

Usage:
    python .planning/spike-w6-browser-test.py --port 3457 --session 0
"""

import argparse
import json
import pathlib
import subprocess
import sys
import time

import pyotp
from playwright.sync_api import sync_playwright


def poll(fn, timeout_s: float = 10.0, interval_s: float = 0.1) -> bool:
    """Poll until fn() returns truthy. Returns True on success, False on timeout."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(interval_s)
    return False

REPO = pathlib.Path(__file__).resolve().parent.parent
INJECTOR = REPO / ".planning" / "spike-w6-input-inject.js"
TOTP_SECRET = json.loads((REPO / ".totp-secret").read_text())["secret"]


def current_totp() -> str:
    return pyotp.TOTP(TOTP_SECRET).now()


def inject(port: int, session: int, text: str) -> None:
    r = subprocess.run(
        ["node", str(INJECTOR), "--port", str(port), "--session", str(session), "--text", text],
        capture_output=True, text=True, timeout=15
    )
    if r.returncode != 0:
        print(f"  [inject failed] {r.stderr}", file=sys.stderr)


def grid_text(page) -> str:
    return page.evaluate("""() => {
        const g = document.querySelector('.grid-term');
        return g ? g.innerText : '';
    }""")


def run_test(port: int, session: int, label: str) -> dict:
    print(f"\n=== {label} (port {port}) ===")
    ts = int(time.time())
    mark_before = f"BEFORE_{ts}"
    mark_after = f"AFTER_{ts}"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        # Auto-accept the TOFU fingerprint dialog on first connect.
        page.on("dialog", lambda d: d.accept())

        url = f"http://localhost:{port}/?renderer=grid"
        page.goto(url, wait_until="domcontentloaded")

        # Wait for the auth screen.
        page.wait_for_selector("#totp-input", state="visible", timeout=15000)
        page.fill("#totp-input", current_totp())
        page.click("#auth-submit-btn")

        # Wait for the terminal area to render with content.
        page.wait_for_selector(".grid-term", state="visible", timeout=10000)
        poll(lambda: len(grid_text(page)) > 5, timeout_s=10.0)
        time.sleep(0.5)
        baseline_len = len(grid_text(page))
        print(f"  baseline rendered: {baseline_len} chars")

        # Inject pre-reconnect marker.
        inject(port, session, f"echo {mark_before}\n")
        before_seen = poll(lambda: mark_before in grid_text(page), timeout_s=5.0)
        print(f"  {mark_before} visible pre-drop: {before_seen}")

        # Force a WS drop. The client schedules doConnect('reconnect') after
        # reconnectDelay (1s initial), then re-auths via sessionToken.
        page.evaluate("ws.close()")
        # Wait for the reconnect cycle to complete: WS readyState OPEN again.
        # readyState is checkable via page.evaluate without page-side eval.
        poll(lambda: page.evaluate("() => ws && ws.readyState === 1"), timeout_s=10.0)
        # Small grace period for the server's post-auth `connect` reply to land.
        time.sleep(1.5)

        # Inject post-reconnect marker.
        inject(port, session, f"echo {mark_after}\n")
        after_seen = poll(lambda: mark_after in grid_text(page), timeout_s=5.0)
        print(f"  {mark_after} visible post-reconnect: {after_seen}")

        screenshot_path = REPO / ".planning" / f"spike-w6-{label}-{ts}.png"
        page.screenshot(path=str(screenshot_path))
        print(f"  screenshot: {screenshot_path}")

        ctx.close()
        browser.close()

    return {
        "label": label,
        "port": port,
        "before_seen": before_seen,
        "after_seen": after_seen,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--patched-port", type=int, default=3457)
    ap.add_argument("--patched-session", type=int, default=0)
    ap.add_argument("--unpatched-port", type=int, default=3456)
    ap.add_argument("--unpatched-session", type=int, default=1)
    args = ap.parse_args()

    patched = run_test(args.patched_port, args.patched_session, "patched")
    unpatched = run_test(args.unpatched_port, args.unpatched_session, "unpatched")

    print("\n=== verdict ===")
    print(f"  patched ({args.patched_port}):   before={patched['before_seen']} after={patched['after_seen']}")
    print(f"  unpatched ({args.unpatched_port}): before={unpatched['before_seen']} after={unpatched['after_seen']}")

    if (patched["before_seen"] and patched["after_seen"]
            and unpatched["before_seen"] and not unpatched["after_seen"]):
        print("  -> FIX VERIFIED. Patched server renders new output after reconnect; unpatched does not.")
        sys.exit(0)
    if patched["after_seen"] and unpatched["after_seen"]:
        print("  -> Both servers render after reconnect. Either bug is gone or test is invalid.")
        sys.exit(1)
    if not patched["after_seen"]:
        print("  -> Patched server FAILED. Fix may be incomplete.")
        sys.exit(2)
    print("  -> Inconclusive. See output above.")
    sys.exit(3)


if __name__ == "__main__":
    main()
