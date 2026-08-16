"""
T04b verification against the REAL server (integration branch, port 3458)
serving the REAL tightened CSP: script-src 'self', connect-src 'self'.

The load-bearing question is the WebSocket. CSP `connect-src 'self'` has a
history of inconsistent ws:/wss: handling across browsers; if 'self' does not
cover the socket, the app is dead on arrival. Assert it, do not assume it.
"""
import sys, json
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3458"

def main():
    fails, passes = 0, 0
    def check(name, ok, extra=""):
        nonlocal fails, passes
        if ok:
            passes += 1; print(f"  PASS  {name}" + (f"  {extra}" if extra else ""))
        else:
            fails += 1; print(f"  FAIL  {name}  {extra}")

    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---- main app page ----
        page = b.new_page()
        csp, errs = [], []
        page.on("console", lambda m: csp.append(m.text)
                if "Content Security Policy" in m.text else None)
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(BASE + "/", wait_until="load")
        page.wait_for_timeout(1500)

        check("index: app.js executed (renderRow defined)",
              page.evaluate("() => typeof renderRow === 'function'"))
        check("index: XSS guard active under tightened CSP",
              page.evaluate("() => renderRow([{text:'x',sgr:{hyperlink:'javascript:alert(1)'}}])"
                            ".firstElementChild.tagName === 'SPAN'"))
        check("index: NO CSP violations", not csp, str(csp[:2]))
        real_errs = [e for e in errs if "WebSocket" not in e]
        check("index: no unexpected page errors", not real_errs, str(real_errs[:2]))

        # ---- THE critical one: does connect-src 'self' permit the WebSocket? ----
        ws_res = page.evaluate("""() => new Promise(resolve => {
            const url = location.origin.replace(/^http/, 'ws') + '/';
            let ws;
            try { ws = new WebSocket(url); }
            catch (e) { return resolve({blocked: true, how: 'constructor threw: ' + e.message}); }
            const done = r => { try { ws.close(); } catch(e){} resolve(r); };
            ws.onopen  = () => done({blocked: false, how: 'opened'});
            // A CSP block surfaces as an immediate error with no open.
            ws.onerror = () => done({blocked: true, how: 'error before open'});
            setTimeout(() => done({blocked: true, how: 'timeout'}), 4000);
        })""")
        check("WEBSOCKET allowed by connect-src 'self'",
              ws_res.get("blocked") is False, json.dumps(ws_res))
        ws_csp = [c for c in csp if "connect-src" in c or "WebSocket" in c]
        check("no connect-src violation logged", not ws_csp, str(ws_csp[:2]))

        # ---- setup page ----
        sp = b.new_page()
        scsp, serrs = [], []
        sp.on("console", lambda m: scsp.append(m.text)
              if "Content Security Policy" in m.text else None)
        sp.on("pageerror", lambda e: serrs.append(str(e)))
        sp.goto(BASE + "/setup", wait_until="load")
        sp.wait_for_timeout(1500)
        check("setup: page reachable from localhost",
              "Setup" in sp.content() or sp.locator("#init-qr, #btn-reset").count() > 0)
        check("setup: setup.js executed (DOM wired by script)",
              sp.evaluate("() => document.querySelectorAll('button').length > 0"))
        check("setup: NO CSP violations", not scsp, str(scsp[:2]))
        check("setup: no page errors", not serrs, str(serrs[:2]))

        # ---- CSRF guard: JSON required unconditionally ----
        r_nojson = sp.evaluate("""async () => {
            const r = await fetch('/api/totp/reset', {method:'POST'});
            return r.status;
        }""")
        check("bodyless POST without JSON -> 415", r_nojson == 415, f"got {r_nojson}")

        r_text = sp.evaluate("""async () => {
            const r = await fetch('/api/totp/reset', {method:'POST',
              headers:{'Content-Type':'text/plain'}, body:'x'});
            return r.status;
        }""")
        check("text/plain POST -> 415", r_text == 415, f"got {r_text}")

        b.close()

    print(f"\n{passes} passed, {fails} failed")
    return 0 if fails == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
