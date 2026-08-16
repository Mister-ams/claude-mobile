"""
W2 (iPad client) behavioural verification -- T12, T13, T14, T15.

Serves the worktree's public/ on a spare port with the real CSP and drives
Chromium at phone (390x844) and iPad (1366x1024) viewports. Nothing here
reasons about the source: every check observes the running client.

What it proves:
  a) at 1366x1024 the terminal fills the screen and the column count is
     materially higher than at 390px
  b) real key events produce the correct bytes toward the PTY (asserted on
     the outgoing WS message payload, with queueSend stubbed)
  c) Ctrl-C maps to 0x03 and Tab does not move focus
  d) swipe handlers are bound at 390px and unbound at 1366px
  e) changing the font setting changes the computed column count AND emits
     a resize message

Run:
  C:\\Users\\MRAL-\\AppData\\Local\\Python\\bin\\python.exe test/w2-ipad-verify.py
"""
import os
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(os.path.dirname(HERE), "public")
PORT = 3462
PHONE = {"width": 390, "height": 844}
IPAD = {"width": 1366, "height": 1024}

# Arms the client as if auth had succeeded and one session were live, and
# replaces the outgoing-message sink so payloads can be asserted. ws /
# activeSession / sessionList are top-level `let` bindings (global lexical
# scope), so plain assignment from an evaluated arrow function reaches them.
ARM = """() => {
  localStorage.setItem('cm-hw-keyboard', 'on');
  window.__sent = [];
  queueSend = (o) => { window.__sent.push(o); };
  authScreen.style.display = 'none';
  appEl.style.display = 'flex';
  ws = { readyState: 1, send() {} };
  sessionList = [{ id: 1, name: 'T1', dir: '/home/x' }];
  activeSession = null;
  switchTo(1);
  applyHwKeyboard();
  return true;
}"""

CLEAR = "() => { window.__sent.length = 0; return true; }"
SENT = "() => window.__sent.filter(m => m.type === 'input').map(m => m.data)"
RESIZES = "() => window.__sent.filter(m => m.type === 'resize')"


def wait_port(p, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", p), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False


class Checks:
    def __init__(self):
        self.rows = []

    def add(self, name, ok, detail=""):
        self.rows.append((name, bool(ok), detail))

    def eq(self, name, got, want):
        self.add(name, got == want, "got %r want %r" % (got, want))

    def report(self):
        failed = 0
        for name, ok, detail in self.rows:
            print("  %s  %s%s" % ("PASS" if ok else "FAIL", name,
                                  "" if ok else "   [%s]" % detail))
            failed += not ok
        return failed


def press_expect(page, c, keys, want, label=None):
    """Press a key, then assert the exact bytes queued toward the PTY."""
    page.evaluate(CLEAR)
    page.keyboard.press(keys)
    page.wait_for_timeout(40)
    got = page.evaluate(SENT)
    c.eq(label or ("key %-14s -> %s" % (keys, repr(want))), got, [want])


def main():
    srv = subprocess.Popen(
        ["node", os.path.join(HERE, "static-server.js"), PUBLIC, str(PORT)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    try:
        if not wait_port(PORT):
            print("FATAL: static server did not start")
            return 1
        c = Checks()
        with sync_playwright() as p:
            b = p.chromium.launch()
            page = b.new_page(viewport=IPAD)
            errors, csp = [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: csp.append(m.text)
                    if "Content Security Policy" in m.text else None)
            page.goto("http://127.0.0.1:%d/" % PORT, wait_until="load")
            page.wait_for_timeout(600)
            page.evaluate(ARM)
            page.wait_for_timeout(400)

            # ── (b)(c) key -> byte translation, iPad viewport ──
            print("\n(b)(c) hardware key -> PTY bytes  [1366x1024]")
            press_expect(page, c, "a", "a")
            press_expect(page, c, "Enter", "\r")
            press_expect(page, c, "Backspace", "\x7f")
            press_expect(page, c, "Escape", "\x1b")
            press_expect(page, c, "ArrowUp", "\x1b[A")
            press_expect(page, c, "ArrowDown", "\x1b[B")
            press_expect(page, c, "ArrowRight", "\x1b[C")
            press_expect(page, c, "ArrowLeft", "\x1b[D")
            press_expect(page, c, "Home", "\x1b[H")
            press_expect(page, c, "End", "\x1b[F")
            press_expect(page, c, "PageUp", "\x1b[5~")
            press_expect(page, c, "PageDown", "\x1b[6~")
            press_expect(page, c, "Control+c", "\x03")
            press_expect(page, c, "Control+d", "\x04")
            press_expect(page, c, "Control+z", "\x1a")
            press_expect(page, c, "Control+r", "\x12")
            press_expect(page, c, "Shift+Tab", "\x1b[Z")

            # Tab: correct byte AND focus must not escape the terminal.
            page.evaluate(CLEAR)
            before = page.evaluate("() => document.activeElement.tagName")
            page.keyboard.press("Tab")
            page.wait_for_timeout(40)
            c.eq("key Tab            -> '\\t'", page.evaluate(SENT), ["\t"])
            c.eq("Tab does not move focus",
                 page.evaluate("() => document.activeElement.tagName"), before)
            c.add("Tab keydown is preventDefault-ed", page.evaluate(
                """() => !document.dispatchEvent(new KeyboardEvent(
                     'keydown', {key:'Tab', bubbles:true, cancelable:true}))"""))

            # ── ATOMICITY: text + Enter must be ONE pty write ──
            page.evaluate(CLEAR)
            page.evaluate("""() => {
              for (const k of ['l','s'])
                document.dispatchEvent(new KeyboardEvent('keydown',
                  {key:k, bubbles:true, cancelable:true}));
              document.dispatchEvent(new KeyboardEvent('keydown',
                {key:'Enter', bubbles:true, cancelable:true}));
            }""")
            page.wait_for_timeout(60)
            c.eq("text+Enter is a SINGLE atomic write", page.evaluate(SENT), ["ls\r"])

            # ── guards ──
            page.evaluate(CLEAR)
            page.evaluate("() => msgInput.focus()")
            page.keyboard.press("a")
            page.wait_for_timeout(40)
            c.eq("compose box focused -> nothing to PTY", page.evaluate(SENT), [])
            c.eq("compose box got the character",
                 page.evaluate("() => msgInput.value"), "a")
            page.evaluate("() => { msgInput.value=''; msgInput.blur(); }")

            page.evaluate(CLEAR)
            page.keyboard.press("Meta+k")
            page.wait_for_timeout(40)
            c.add("Cmd-K focuses the compose box",
                  page.evaluate("() => document.activeElement === msgInput"))
            page.evaluate("() => msgInput.blur()")

            page.evaluate(CLEAR)
            page.evaluate("() => setHwKeyboard(false)")
            page.keyboard.press("a")
            page.wait_for_timeout(40)
            c.eq("setting OFF -> no keys forwarded", page.evaluate(SENT), [])
            page.evaluate("() => setHwKeyboard(true)")

            page.evaluate(CLEAR)
            page.evaluate("() => { activeSession = null; }")
            page.keyboard.press("a")
            page.wait_for_timeout(40)
            c.eq("no active session -> no keys forwarded", page.evaluate(SENT), [])
            page.evaluate("() => { activeSession = 1; }")

            # ── (a) full-screen terminal + column count ──
            print("\n(a) layout")
            ipad = page.evaluate("""() => ({
              cols: computeGridDims(gridTerms[activeSession]).cols,
              rows: computeGridDims(gridTerms[activeSession]).rows,
              termH: document.getElementById('term-area').clientHeight,
              winH: window.innerHeight,
              qbar: getComputedStyle(document.getElementById('qbar')).display,
              strip: getComputedStyle(document.getElementById('tab-switcher')).display,
              pill: getComputedStyle(document.getElementById('tab-pill')).display,
              hscroll: document.documentElement.scrollWidth
                       - document.documentElement.clientWidth,
              font: getFontSize(),
            })""")
            c.add("iPad: quick-action bar hidden", ipad["qbar"] == "none",
                  ipad["qbar"])
            c.add("iPad: tab strip persistent (not an overlay)",
                  ipad["strip"] == "flex" and ipad["pill"] == "none", str(ipad))
            c.add("iPad: terminal >= 80%% of viewport height (%d/%d)"
                  % (ipad["termH"], ipad["winH"]),
                  ipad["termH"] >= 0.80 * ipad["winH"])
            c.add("iPad: no horizontal body scroll", ipad["hscroll"] <= 0,
                  str(ipad["hscroll"]))
            c.add("iPad: hardware keyboard defaults ON", page.evaluate(
                """() => { const v = localStorage.getItem('cm-hw-keyboard');
                           localStorage.removeItem('cm-hw-keyboard');
                           const d = hwKeyboardEnabled();
                           localStorage.setItem('cm-hw-keyboard', v);
                           return d; }"""))

            # ── (e) font size setting ──
            print("\n(e) font size setting")
            page.evaluate(CLEAR)
            base = page.evaluate("() => computeGridDims(gridTerms[activeSession]).cols")
            default_px = page.evaluate("() => getFontSize()")
            c.eq("iPad default font is 16px", default_px, 16)
            page.evaluate("() => setFontSize(22)")
            page.wait_for_timeout(200)
            big = page.evaluate("() => computeGridDims(gridTerms[activeSession]).cols")
            resizes = page.evaluate(RESIZES)
            c.add("larger font -> fewer columns (%d -> %d)" % (base, big),
                  big < base)
            c.add("font change emits a resize message %s" % resizes,
                  len(resizes) > 0 and resizes[-1]["cols"] == big)
            c.add("font size persists to localStorage", page.evaluate(
                "() => localStorage.getItem('cm-font-size') === '22'"))
            page.evaluate("() => setFontSize(13)")
            page.wait_for_timeout(200)
            small = page.evaluate("() => computeGridDims(gridTerms[activeSession]).cols")
            c.add("13px gives more columns than the 16px default (%d > %d)"
                  % (small, base), small > base)
            # clearing the stored size falls back to the per-layout default
            page.evaluate("""() => { localStorage.removeItem('cm-font-size');
                                     applyFontSize(); }""")
            page.wait_for_timeout(200)
            c.eq("cleared setting -> default font -> columns restored",
                 page.evaluate("() => computeGridDims(gridTerms[activeSession]).cols"),
                 base)

            # ── (d) swipe gating + phone-width comparison ──
            print("\n(d) swipe gating / phone width")
            c.add("iPad: swipe handlers NOT bound",
                  page.evaluate("() => swipeNavigationActive() === false"),
                  str(page.evaluate("() => swipeNavigationActive()")))

            page.set_viewport_size(PHONE)
            page.wait_for_timeout(400)
            phone = page.evaluate("""() => ({
              cols: computeGridDims(gridTerms[activeSession]).cols,
              termH: document.getElementById('term-area').clientHeight,
              winH: window.innerHeight,
              qbar: getComputedStyle(document.getElementById('qbar')).display,
              pill: getComputedStyle(document.getElementById('tab-pill')).display,
              hscroll: document.documentElement.scrollWidth
                       - document.documentElement.clientWidth,
              swipe: swipeNavigationActive(),
            })""")
            c.add("phone: swipe handlers bound", phone["swipe"] is True,
                  str(phone["swipe"]))
            c.add("phone: quick-action bar restored", phone["qbar"] != "none")
            c.add("phone: session pill restored", phone["pill"] != "none")
            c.add("phone: no horizontal body scroll", phone["hscroll"] <= 0,
                  str(phone["hscroll"]))
            c.add("iPad columns materially higher than phone (%d vs %d)"
                  % (ipad["cols"], phone["cols"]),
                  ipad["cols"] >= 1.7 * phone["cols"])
            c.add("iPad terminal taller share of viewport than phone "
                  "(%.2f vs %.2f)" % (ipad["termH"] / ipad["winH"],
                                      phone["termH"] / phone["winH"]),
                  ipad["termH"] / ipad["winH"] > phone["termH"] / phone["winH"])

            # phone still types when the setting is explicitly on
            page.evaluate(CLEAR)
            page.keyboard.press("Control+c")
            page.wait_for_timeout(40)
            c.eq("phone with setting ON still forwards Ctrl-C",
                 page.evaluate(SENT), ["\x03"])

            # no-horizontal-scroll sweep across the breakpoints
            for w in (390, 768, 820, 1024, 1180, 1366):
                page.set_viewport_size({"width": w, "height": 900})
                page.wait_for_timeout(120)
                over = page.evaluate("() => document.documentElement.scrollWidth"
                                     " - document.documentElement.clientWidth")
                c.add("no horizontal scroll at %dpx" % w, over <= 0, str(over))

            print("\nchecks:")
            failed = c.report()

            real = [e for e in errors if "WebSocket" not in e]
            if real:
                print("\nunexpected page errors:")
                for e in real:
                    print("   ", e)
                failed += 1
            else:
                print("\nno unexpected page errors "
                      "(WebSocket failure is expected: no backend)")
            if csp:
                print("CSP violations:", csp)
                failed += 1
            else:
                print("no CSP violations")
            b.close()
        print("\n%s" % ("ALL PASS" if failed == 0 else "%d FAILED" % failed))
        return 0 if failed == 0 else 1
    finally:
        srv.terminate()


if __name__ == "__main__":
    sys.exit(main())
