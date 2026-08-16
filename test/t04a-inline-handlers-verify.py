r"""
T04a (inline event handlers -> addEventListener) behavioural verification.

Serves the worktree's public/ on a spare port with the CSP T04 will actually
ship -- script-src 'self', NO 'unsafe-inline' -- and drives Chromium at phone
width (390x844, where the quick bar and the session pill are visible; the
>=820px layout hides them). Nothing here reasons about the source: every check
observes the running client under the end-state policy.

What it proves:
  a) not one inline on* attribute survives, asserted twice: by regex over
     public/index.html and by DOM query in the loaded document
  b) under the tightened CSP the page raises zero CSP violations and zero
     page errors
  c) every converted control still does what its attribute did -- asserted on
     the outgoing PTY payload where there is one (queueSend stubbed), on the
     DOM effect where there is not
  d) the iOS double-fire guard holds. Chromium's touch emulation really does
     synthesise the compatibility click (proved here against an UNGUARDED
     clone of the same button), so "tap fires the action once" is a real
     result and not an artefact of the emulator
  e) the compose box keeps focus when the quick bar is pressed, by touch and
     by mouse, on a button and on the bar background -- with a control that
     shows the check can detect focus loss

Run:
  C:\Users\MRAL-\AppData\Local\Python\bin\python.exe test/t04a-inline-handlers-verify.py
"""
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, "public")
PHONE = {"width": 390, "height": 844}

INLINE_ATTR_RE = re.compile(
    r"""\son(?:click|focus|blur|keydown|keyup|keypress|mousedown|mouseup|mousemove"""
    r"""|touchstart|touchend|touchmove|touchcancel|change|input|submit|load|error"""
    r"""|scroll|wheel|paste|copy|cut|drag\w*|drop|contextmenu)\s*=""",
    re.IGNORECASE,
)
# Comments are stripped first: the markup now carries a note explaining why
# there are no on* attributes, and the word "onclick=" inside it is prose, not
# a handler. The DOM assertion below is what covers the live document.
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)

# Pre-auth fixture: with a real backend /api/auth/status shows these two
# (checkAuthStatus sets exactly these styles). The static server has no API, so
# the harness puts the auth screen into the state a provisioned server would.
AUTH_FIXTURE = """() => {
  window.__auth = [];
  authAction = (m) => { window.__auth.push(m); };
  $('passkey-btn').style.display = 'block';
  $('totp-section').style.display = 'block';
  return true;
}"""

# Arms the client as if auth had succeeded, and replaces the outgoing-message
# sink so payloads can be asserted. ws / activeSession / sessionList / lastSent
# / userScrolled are top-level `let` bindings (global lexical scope), so plain
# assignment from an evaluated arrow function reaches them.
ARM_NO_SESSION = """() => {
  localStorage.setItem('cm-hw-keyboard', 'off');
  window.__sent = [];
  queueSend = (o) => { window.__sent.push(o); };
  authScreen.style.display = 'none';
  appEl.style.display = 'flex';
  ws = { readyState: 1, send() {} };
  sessionList = [];
  activeSession = null;
  return true;
}"""

ARM_SESSION = """() => {
  sessionList = [{ id: 1, name: 'T1', dir: '/home/x' }];
  switchTo(1);
  updateHdr();
  return true;
}"""

CLEAR = "() => { window.__sent.length = 0; return true; }"
SENT = "() => window.__sent.filter(m => m.type === 'input').map(m => m.data)"
ALL_SENT = "() => window.__sent"

# Records the raw event sequence a press produces on a given element.
WATCH = """(sel) => {
  window.__ev = [];
  const el = document.querySelector(sel);
  for (const t of ['touchstart','touchend','mousedown','mouseup','click'])
    el.addEventListener(t, e => window.__ev.push(
      t + (e.type === 'touchend' && e.defaultPrevented ? '(pd)' : '')));
  return true;
}"""

# An unguarded twin of the Esc button: cloneNode does not carry
# addEventListener registrations, so this button has NO touchend guard. If
# Chromium synthesises a compat click for it, the emulator is faithful and the
# guarded button's missing click is a real result.
CONTROL_CLONE = """() => {
  const src = document.querySelector('[data-qb="esc"]');
  const c = src.cloneNode(true);
  c.id = 'unguarded-twin';
  c.dataset.qb = 'twin';
  window.__twin = [];
  for (const t of ['touchstart','touchend','mousedown','mouseup','click'])
    c.addEventListener(t, e => window.__twin.push(t));
  src.parentNode.appendChild(c);
  return true;
}"""


def free_port():
    """An ephemeral port the OS just handed us, not a hardcoded one. Other
    worktrees run their own harnesses on this box; 3462/3463 were both taken."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_port(p, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", p), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def serves_this_worktree(port):
    """Guard against answering-but-wrong servers. A port that merely accepts
    connections proves nothing: on the first T04a run the port was already held
    by another checkout's harness, which cheerfully served ITS index.html --
    complete with the inline handlers this task removes. Compare raw bytes
    (the repo checks out CRLF here, so text mode would false-negative)."""
    disk = open(os.path.join(PUBLIC, "index.html"), "rb").read()
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=5) as r:
            return r.read() == disk
    except OSError:
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


def centre(page, sel):
    box = page.query_selector(sel).bounding_box()
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def tap(page, sel):
    page.touchscreen.tap(*centre(page, sel))


def brief(s):
    """repr() of a payload, with long runs collapsed -- clearPrompt sends 500
    DELs and the raw repr buries every other line of the report."""
    if len(s) > 8 and len(set(s)) == 1:
        return "%r * %d" % (s[0], len(s))
    return repr(s)


def qb_bytes(page, c, sel, want, how, label):
    """Press one quick-bar button and assert the exact bytes queued to the PTY."""
    page.evaluate(CLEAR)
    if how == "tap":
        tap(page, sel)
    else:
        page.click(sel)
    page.wait_for_timeout(160)   # clearPrompt's second write lands at +30ms
    got = page.evaluate(SENT)
    c.add("%-8s %-5s -> %s" % (label, how, ", ".join(brief(w) for w in want)),
          got == want, "got %s" % ", ".join(brief(w) for w in got))


def main():
    # ── (a) part 1: the source itself ──
    html = open(os.path.join(PUBLIC, "index.html"), encoding="utf8").read()
    static_hits = INLINE_ATTR_RE.findall(HTML_COMMENT_RE.sub("", html))

    PORT = free_port()
    srv = subprocess.Popen(
        ["node", os.path.join(HERE, "static-server.js"), PUBLIC, str(PORT), "tight"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    try:
        if not wait_port(PORT):
            print("FATAL: static server did not start on port %d" % PORT)
            return 1
        if not serves_this_worktree(PORT):
            print("FATAL: port %d is answering with someone else's public/ -- "
                  "refusing to report on a tree that is not this one" % PORT)
            return 1
        print("serving %s on 127.0.0.1:%d (content verified as this worktree)"
              % (PUBLIC, PORT))
        c = Checks()
        c.eq("no inline on* attribute in public/index.html (regex)",
             static_hits, [])

        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport=PHONE, has_touch=True)
            page = ctx.new_page()
            errors, csp = [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: csp.append(m.text)
                    if ("Content Security Policy" in m.text
                        or "Refused to execute" in m.text
                        or "Refused to apply" in m.text) else None)
            resp = page.goto("http://127.0.0.1:%d/" % PORT, wait_until="load")
            page.wait_for_timeout(600)

            # ── (b) the policy under test really is the tightened one ──
            print("\n(b) policy actually served")
            policy = resp.header_value("content-security-policy") or ""
            script_src = next((d.strip() for d in policy.split(";")
                               if d.strip().startswith("script-src")), "")
            c.eq("served script-src is the T04 end state", script_src,
                 "script-src 'self'")
            c.add("no 'unsafe-inline' anywhere in script-src",
                  "unsafe-inline" not in script_src, script_src)

            # ── (a) part 2: the loaded document ──
            print("\n(a) inline handler attributes")
            c.eq("DOM: [onclick],[ontouchend],[onfocus],[onblur],[onkeydown],"
                 "[onmousedown],[ontouchstart] count",
                 page.evaluate("""() => document.querySelectorAll(
                     '[onclick],[ontouchend],[onfocus],[onblur],[onkeydown],'
                     + '[onmousedown],[ontouchstart]').length"""), 0)
            c.eq("DOM: any attribute whose name starts with 'on'",
                 page.evaluate("""() => {
                   const out = [];
                   for (const el of document.querySelectorAll('*'))
                     for (const a of el.attributes)
                       if (/^on/i.test(a.name))
                         out.push(el.tagName + '[' + a.name + ']');
                   return out;
                 }"""), [])

            # ── (c) auth buttons, still on the auth screen ──
            print("\n(c) converted controls")
            page.evaluate(AUTH_FIXTURE)
            page.click("#passkey-btn")
            page.click("#auth-submit-btn")
            page.wait_for_timeout(80)
            c.eq("auth buttons -> authAction(method)",
                 page.evaluate("() => window.__auth"), ["passkey", "totp"])

            # ── empty state: only reachable before a session exists ──
            page.evaluate(ARM_NO_SESSION)
            page.wait_for_timeout(200)
            page.click("#empty-state")
            page.wait_for_timeout(120)
            created = page.evaluate(
                "() => window.__sent.filter(m => m.type === 'create')")
            c.add("#empty-state click -> newSession() create message %s"
                  % created, len(created) == 1 and created[0]["name"] == "SESSION 1")

            page.evaluate(ARM_SESSION)
            page.wait_for_timeout(300)

            # ── session-name input: focus / keydown / blur ──
            page.evaluate(CLEAR)
            page.click("#sname")
            page.wait_for_timeout(80)
            sel = page.evaluate("""() => ({
              start: sname.selectionStart, end: sname.selectionEnd,
              len: sname.value.length, focused: document.activeElement === sname,
            })""")
            c.add("#sname focus -> whole value selected %s" % sel,
                  sel["focused"] and sel["start"] == 0
                  and sel["end"] == sel["len"] and sel["len"] > 0)

            page.keyboard.type("RENAMED")
            page.keyboard.press("Enter")
            page.wait_for_timeout(120)
            c.add("#sname Enter -> blur()", page.evaluate(
                "() => document.activeElement !== sname"))
            renames = page.evaluate(
                "() => window.__sent.filter(m => m.type === 'rename')")
            c.add("#sname blur -> commitRename() rename message %s" % renames,
                  len(renames) == 1 and renames[0]["name"] == "RENAMED")

            # ── quick bar: exact bytes, mouse path then touch path ──
            esc, up, down = '\x1b', '\x1b[A', '\x1b[B'
            clear_prompt = ['\x1b[F', '\x7f' * 500]
            page.evaluate("() => { lastSent = 'ls -la'; msgInput.value = ''; }")
            for how in ("click", "tap"):
                qb_bytes(page, c, '[data-qb="esc"]', [esc], how, "qb Esc")
                qb_bytes(page, c, '[data-qb="up"]', [up], how, "qb Up")
                qb_bytes(page, c, '[data-qb="down"]', [down], how, "qb Down")
                qb_bytes(page, c, '[data-qb="clear"]', clear_prompt, how, "qb Clear")
                page.evaluate("() => { msgInput.value = ''; }")
                qb_bytes(page, c, '[data-qb="edit"]', clear_prompt, how, "qb Edit")
                c.eq("qb Edit  %-5s -> compose box refilled" % how,
                     page.evaluate("() => msgInput.value"), "ls -la")
            page.evaluate("() => { msgInput.value = ''; msgInput.blur(); }")

            # ── theme / pill / count button ──
            before = page.evaluate(
                "() => document.documentElement.classList.contains('light')")
            page.click("#theme-toggle")
            page.wait_for_timeout(80)
            c.add("#theme-toggle click -> theme flips + persists", page.evaluate(
                """(b) => document.documentElement.classList.contains('light') !== b
                     && localStorage.getItem('cm-theme') ===
                        (b ? 'dark' : 'light')""", before))
            page.click("#theme-toggle")
            page.wait_for_timeout(80)

            page.evaluate("() => { userScrolled = true; }")
            page.click("#tab-pill")
            page.wait_for_timeout(120)
            c.add("#tab-pill click -> scrollBottom() clears userScrolled",
                  page.evaluate("() => userScrolled === false"))

            open_state = "() => $('tab-switcher').classList.contains('open')"
            c.add("#tab-count-btn starts closed",
                  page.evaluate(open_state) is False)
            page.click("#tab-count-btn")
            page.wait_for_timeout(120)
            opened = page.evaluate(open_state)
            page.click("#tab-count-btn")
            page.wait_for_timeout(120)
            c.add("#tab-count-btn click -> toggleSwitcher() opens then closes",
                  opened is True and page.evaluate(open_state) is False)

            # ── (d) iOS double-fire guard ──
            print("\n(d) double-fire guard")
            page.evaluate(CONTROL_CLONE)
            tap(page, "#unguarded-twin")
            page.wait_for_timeout(200)
            twin = page.evaluate("() => window.__twin")
            c.add("CONTROL: an unguarded twin DOES get a compat click %s" % twin,
                  "click" in twin,
                  "emulator synthesises no click -- (d) would be vacuous")
            page.evaluate("() => document.getElementById('unguarded-twin').remove()")

            page.evaluate(WATCH, '[data-qb="esc"]')
            page.evaluate(CLEAR)
            tap(page, '[data-qb="esc"]')
            page.wait_for_timeout(250)
            seq = page.evaluate("() => window.__ev")
            c.eq("tap Esc: touchend preventDefault kills the compat click %s"
                 % seq, [e for e in seq if e == "click"], [])
            c.eq("tap Esc: action fires exactly ONCE", page.evaluate(SENT), [esc])

            page.evaluate("() => { window.__ev.length = 0; }")
            page.evaluate(CLEAR)
            page.click('[data-qb="esc"]')
            page.wait_for_timeout(250)
            c.eq("mouse Esc: action fires exactly ONCE %s"
                 % page.evaluate("() => window.__ev"), page.evaluate(SENT), [esc])

            # explicit-dispatch probe: the suppression mechanism is armed
            c.add("touchend on a .qb is preventDefault-ed", page.evaluate(
                """() => !document.querySelector('[data-qb="esc"]').dispatchEvent(
                     new TouchEvent('touchend', {bubbles:true, cancelable:true}))"""))
            c.add("touchstart on the qbar BACKGROUND is preventDefault-ed",
                  page.evaluate(
                      """() => !document.getElementById('qbar').dispatchEvent(
                           new TouchEvent('touchstart', {bubbles:true, cancelable:true}))"""))
            c.add("touchstart ON a .qb is NOT preventDefault-ed (the press must "
                  "run to its touchend)", page.evaluate(
                      """() => document.querySelector('[data-qb="esc"]').dispatchEvent(
                           new TouchEvent('touchstart', {bubbles:true, cancelable:true}))"""))

            # ── (e) compose box keeps focus ──
            print("\n(e) compose focus retention")
            qbar = page.query_selector("#qbar").bounding_box()
            bg_x, bg_y = qbar["x"] + 3, qbar["y"] + qbar["height"] / 2
            c.eq("qbar background probe point really is the bar, not a button",
                 page.evaluate("([x,y]) => document.elementFromPoint(x,y).id",
                               [bg_x, bg_y]), "qbar")

            focused = "() => document.activeElement === msgInput"
            page.evaluate("() => msgInput.focus()")
            tap(page, '[data-qb="esc"]')
            page.wait_for_timeout(150)
            c.add("tap on a quick-bar BUTTON keeps compose focus",
                  page.evaluate(focused),
                  page.evaluate("() => document.activeElement.id"))

            page.evaluate("() => msgInput.focus()")
            page.touchscreen.tap(bg_x, bg_y)
            page.wait_for_timeout(150)
            c.add("tap on the quick-bar BACKGROUND keeps compose focus",
                  page.evaluate(focused),
                  page.evaluate("() => document.activeElement.id"))

            page.evaluate("() => msgInput.focus()")
            page.click('[data-qb="esc"]')
            page.wait_for_timeout(150)
            c.add("mouse click on a quick-bar button keeps compose focus",
                  page.evaluate(focused),
                  page.evaluate("() => document.activeElement.id"))

            page.evaluate("() => msgInput.focus()")
            page.mouse.move(bg_x, bg_y)
            page.mouse.down()
            page.wait_for_timeout(80)
            held = page.evaluate(focused)
            page.mouse.up()
            c.add("mousedown on the quick bar keeps compose focus", held)

            # control: the check above can actually detect focus loss
            page.evaluate("() => msgInput.focus()")
            tx, ty = centre(page, "#theme-toggle")
            page.mouse.move(tx, ty)
            page.mouse.down()
            page.wait_for_timeout(80)
            moved = page.evaluate("() => document.activeElement.id")
            page.mouse.up()
            page.wait_for_timeout(80)
            c.add("CONTROL: mousedown on a NON-guarded button does steal focus "
                  "(-> %s)" % moved, moved != "msg",
                  "focus never moves here, so (e) proves nothing")

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
                print("no CSP violations under script-src 'self'")
            b.close()
        print("\n%s" % ("ALL PASS" if failed == 0 else "%d FAILED" % failed))
        return 0 if failed == 0 else 1
    finally:
        srv.terminate()


if __name__ == "__main__":
    sys.exit(main())
