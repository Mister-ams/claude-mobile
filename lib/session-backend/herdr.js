/**
 * herdr session backend -- Windows-native, no WSL in the path.
 *
 * One claude-mobile session maps to one herdr NAMED session (`cm-0`, `cm-1`,
 * ...). Each named session is its own herdr server with its own socket under
 * %APPDATA%\herdr\sessions\<name>\, so sessions cannot collide with each other
 * and cannot touch the operator's own default herdr session.
 *
 * The pty hosts the herdr CLIENT; the herdr server behind it is what actually
 * persists. That is the same division of labour dtach has -- the pty is
 * disposable, the thing holding the shell is not.
 *
 * ── Why the server is started separately, and orphaned ───────────
 *
 * `herdr --session <name>` will bring a session up on its own, and the server
 * outlives the pty client being killed -- but it is a CHILD of this process,
 * and PM2 restarts by tree-killing (taskkill /T). Measured: the session was
 * running before `pm2 restart` and gone after it, which is the one thing the
 * backend exists to prevent.
 *
 * `detached: true` does NOT fix this on Windows. It gives the child its own
 * console and stops it dying with the parent, but the parent-PID record stays
 * and taskkill /T walks exactly that. Also measured, also died.
 *
 * So the server is launched through a throwaway node process that exits
 * immediately. By the time PM2 enumerates our descendants the server has no
 * living parent and is not one of them. A `cmd /c start` would orphan it just
 * as well, but that puts a shell back in the launch path that T23 deliberately
 * removed, so the launcher is node with an argv array and no shell anywhere.
 *
 * This is the same shape dtach has: `dtach -n` daemonises first and the client
 * attaches to something that was never ours.
 *
 * ── Measured on this machine, 2026-08-23 (herdr 0.8.2) ───────────
 *
 *   headless `herdr server` + HERDR_SESSION      hosts a named session
 *   orphaned server survives taskkill /T /F      running: true, pane intact
 *   `workspace create --cwd`                     pane opens at the project dir
 *   `pane run` with NO client attached           command reaches the shell
 *   `herdr session attach <name>`                reattaches, state intact
 *   proc.resize() reaches the pane               viewport_rows 29 -> 18
 *   pane geometry at pty 50x30                   49x28  (1 col, 2 rows lost)
 *   pane geometry at pty 120x40, default config  93x39  (27 cols lost)
 *   pane geometry at pty 120x40, lean config    119x40  (1 col lost)
 *
 * That last pair is why this backend ships its own config file rather than
 * using the operator's: herdr's sidebar costs 27 columns at iPad width, and
 * the phone is already down to 49. See herdr-config.toml.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

// The throwaway launcher, as source rather than a file so there is nothing to
// install or keep in sync. It spawns herdr and exits, which is what orphans
// the server; argv is an array, so no shell ever sees these values.
//
// It passes its OWN env straight through, and that is deliberate: the caller
// hands it the whitelisted env, so `process.env` here is already filtered.
// Building the env inside the launcher instead would splice in whatever
// happened to be in this process -- and since the herdr SERVER owns the panes,
// that environment is the one Claude inherits, not the pty client's. Passing
// the unfiltered env here silently defeated ENV_WHITELIST for the only process
// that matters; a stray CLAUDE_CODE_CHILD_SESSION from the launching shell was
// enough to turn transcript saving off in every session on this backend.
const ORPHAN_LAUNCHER =
  "const {spawn}=require('child_process');" +
  "const c=spawn(process.argv[1],['server'],{cwd:process.argv[2]," +
  "env:process.env,detached:true,stdio:'ignore',windowsHide:true});" +
  "c.unref();process.exit(0);";

module.exports = function createHerdrBackend({ config, audit, getSafeEnv, pty, setLastError }) {
  const BIN = config.herdrBin || path.join(os.homedir(), 'tools', 'herdr', 'herdr.exe');
  const CONFIG_PATH = config.herdrConfigPath ||
    path.join(__dirname, '..', '..', 'herdr-config.toml');
  const PREFIX = config.sessionPrefix || 'cm';

  // How long a fresh session may take to come up. Measured worst case on this
  // box was ~4s to a running server; 15s leaves room for a cold binary read.
  const CREATE_TIMEOUT_MS = 15000;
  const POLL_MS = 500;

  let available = false;

  // herdr session names are lowercase-alphanumeric with - and _; `cm-0` fits.
  // Guard anyway, because an id that cannot be named is a session that can
  // never be recovered, and that failure would surface much later.
  const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  function sessionName(id) {
    const name = `${PREFIX}-${id}`;
    if (!NAME_RE.test(name)) {
      throw new Error(`invalid herdr session name "${name}" -- check sessionPrefix in config.json`);
    }
    return name;
  }

  // Every CLI call is execFileSync with an argv array: no shell, so a project
  // directory containing a backtick or & is an argument, never syntax. Same
  // rule the dtach backend follows for wsl.exe.
  //
  // The env is the whitelist, not this process's -- otherwise an ambient
  // HERDR_SESSION or HERDR_PANE_ID silently redirects every call. That is not
  // hypothetical once herdr is the daily driver: a claude-mobile started from
  // inside a herdr pane inherits exactly those variables, and each read would
  // then answer about the operator's pane instead of ours.
  function cli(args, extraEnv) {
    return execFileSync(BIN, args, {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
      env: { ...getSafeEnv(), HERDR_CONFIG_PATH: CONFIG_PATH, ...(extraEnv || {}) },
    }).trim();
  }

  // The one read every other question is answered from. Throws when herdr
  // could not be asked -- callers must NOT read that as "no sessions".
  function listSessions() {
    const raw = cli(['session', 'list', '--json']);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.sessions)) {
      throw new Error('session list returned no sessions array');
    }
    return parsed.sessions;
  }

  function recordFor(id, sessions) {
    const name = sessionName(id);
    return sessions.find(s => s.name === name) || null;
  }

  // A stopped session record is herdr's equivalent of dtach's unheld socket
  // file: a leftover that would make the name un-creatable. Clear it on read
  // rather than sweeping them on a schedule.
  function deleteStopped(id) {
    const name = sessionName(id);
    try {
      cli(['session', 'delete', name, '--json']);
      audit('SESSION', `Stopped herdr session removed: ${name}`);
    } catch (e) {
      audit('WARN', `herdr session delete failed for ${name}: ${e.message}`);
    }
  }

  function probeBinary() {
    try {
      if (!fs.existsSync(BIN)) throw new Error(`herdr binary not found at ${BIN}`);
      cli(['--version']);
      // A binary that runs but whose socket API is unreachable is not usable,
      // so the probe has to reach the API too.
      listSessions();
      available = true;
      return true;
    } catch (e) {
      available = false;
      setLastError(`herdr probe failed: ${e.message}`);
      return false;
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  return {
    kind: 'herdr',

    describe() { return `herdr ${PREFIX}-* sessions (native ConPTY, no WSL)`; },

    label(id) { return `${PREFIX}-${id}`; },

    isAvailable() { return available; },

    init() {
      if (probeBinary()) {
        console.log(`[init] herdr available at ${BIN}`);
        console.log(`[init] herdr config: ${CONFIG_PATH}` +
                    (fs.existsSync(CONFIG_PATH) ? '' : '  (MISSING -- herdr defaults apply)'));
        return;
      }
      console.warn('[init] herdr not available, retrying in 5s...');
      const retryInterval = setInterval(() => {
        if (probeBinary()) {
          console.log('[init] herdr now available');
          clearInterval(retryInterval);
        }
      }, 5000);
      setTimeout(() => clearInterval(retryInterval), 120000);
    },

    state(id) {
      let sessions;
      try {
        sessions = listSessions();
      } catch (e) {
        // herdr could not be asked. Nothing was learned about this session, and
        // saying 'gone' here would delete a live one.
        audit('WARN', 'herdr state: ' + e.message);
        return 'unknown';
      }
      const rec = recordFor(id, sessions);
      if (!rec) return 'gone';
      if (rec.running === true) return 'alive';
      deleteStopped(id);
      return 'stale';
    },

    alive(id) { return this.state(id) === 'alive'; },

    list() {
      let sessions;
      try {
        sessions = listSessions();
      } catch (e) {
        audit('ERROR', 'herdr list failed: ' + e.message);
        return { live: [], phantom: [] };
      }
      const re = new RegExp(`^${PREFIX}-(\\d+)$`);
      const live = [], phantom = [];
      for (const s of sessions) {
        const m = String(s.name || '').match(re);
        if (!m) continue;
        (s.running === true ? live : phantom).push(parseInt(m[1]));
      }
      return { live, phantom };
    },

    // Daemon first, client second -- the same order as dtach. The pane is
    // created through the socket API rather than by letting the attached
    // client open one, so the project directory is set explicitly and the
    // session is complete before any pty exists. That also means a session
    // survives with a usable pane even if no client ever attaches to it.
    async create(id, { dir, cols, rows }) {
      const name = sessionName(id);

      // A leftover record under this name would make the create ambiguous.
      const pre = this.state(id);
      if (pre === 'alive') {
        audit('WARN', `herdr session ${name} already running -- attaching instead of creating`);
        return this.attach(id, { cols, rows });
      }
      if (pre === 'unknown') {
        audit('ERROR', `herdr create refused: cannot reach herdr to check ${name}`);
        return null;
      }

      try {
        const launcher = spawn(
          process.execPath, ['-e', ORPHAN_LAUNCHER, BIN, dir],
          {
            // The whitelist is applied HERE, once, and inherited down the
            // chain: launcher -> herdr server -> pane -> Claude.
            env: { ...getSafeEnv(), HERDR_SESSION: name, HERDR_CONFIG_PATH: CONFIG_PATH },
            detached: true, stdio: 'ignore', windowsHide: true,
          });
        launcher.unref();
      } catch (e) {
        audit('ERROR', `herdr server launch failed for ${name}: ${e.message}`);
        return null;
      }

      const deadline = Date.now() + CREATE_TIMEOUT_MS;
      let up = false;
      while (Date.now() < deadline && !up) {
        await sleep(POLL_MS);
        try {
          const rec = recordFor(id, listSessions());
          up = !!rec && rec.running === true;
        } catch (e) { /* not up yet */ }
      }
      if (!up) {
        audit('ERROR', `herdr session ${name} never reported running within ${CREATE_TIMEOUT_MS}ms`);
        return null;
      }

      // A headless server starts with no workspace at all, so this is what
      // creates the shell -- and the only place the project directory is set.
      try {
        const out = cli(['workspace', 'create', '--cwd', dir, '--label', name],
          { HERDR_SESSION: name });
        if (!/"pane_id":"/.test(out)) throw new Error(out.slice(0, 160));
      } catch (e) {
        audit('ERROR', `herdr workspace create failed for ${name}: ${e.message}`);
        this.kill(id);
        return null;
      }

      try {
        return this.attach(id, { cols, rows });
      } catch (e) {
        audit('ERROR', `herdr attach after create failed for ${name}: ${e.message}`);
        this.kill(id);
        return null;
      }
    },

    attach(id, { cols, rows }) {
      return pty.spawn(BIN, ['session', 'attach', sessionName(id)], {
        name: 'xterm-256color', cols: cols || 80, rows: rows || 24,
        env: { ...getSafeEnv(), HERDR_CONFIG_PATH: CONFIG_PATH },
      });
    },

    // No Windows interop hop -- the pane's shell is already a Windows shell, so
    // this is plain `claude`. It goes through the socket API rather than the
    // pty, which means it does not race the client's first paint: `pane run`
    // reaches the pane's shell whether or not anything is attached.
    //
    // It does wait for the pane to stop resizing first. `herdr workspace
    // create` takes no --cols/--rows -- a pane is sized by the clients attached
    // to it -- so the sequence is: create the pane, attach the pty (which sizes
    // it), then start Claude. Measured at iPad 13 landscape, the pane reached
    // its 48 rows 1.5s before Claude first painted, so the wait costs nothing
    // in practice. It is here so that margin is a stated precondition rather
    // than an accident of how many CLI round trips happen to precede it:
    // starting Claude into a mis-sized pane is a visible reflow on a screen.
    //
    // The wait is for the pane geometry to SETTLE, not to match a requested
    // number, and that distinction is the whole point.
    //
    // The first attempt waited for the client's requested rows and was inert:
    // the client sends rows=200 on create (public/app.js, newSession), so the
    // pty opens at 200 rows, herdr sizes the pane to about that, and the check
    // passed instantly -- before the browser's real 48 had landed. It looked
    // like a guard and protected nothing, which is worse than having none.
    //
    // Settling is the honest signal: two consecutive reads agreeing means
    // nothing is still resizing the pane, whatever the number is. It is also
    // right for a session with no browser attached, where 200 IS the answer.
    //
    // herdr reports `viewport_rows` and no column count, so rows are all there
    // is to watch -- sufficient, because a pty resize carries both dimensions
    // in one event. The columns are confirmed from outside, by
    // test/herdr-pane-geometry.py.
    launchClaude(proc, id) {
      const name = sessionName(id);
      (async () => {
        const deadline = Date.now() + 20000;
        let paneId = null;
        while (Date.now() < deadline && !paneId) {
          try {
            const out = cli(['pane', 'list'], { HERDR_SESSION: name });
            paneId = (out.match(/"pane_id":"([^"]+)"/) || [])[1] || null;
          } catch (e) { /* keep waiting */ }
          if (!paneId) await sleep(POLL_MS);
        }
        if (!paneId) {
          audit('ERROR', `Claude launch failed for ${name}: no pane appeared`);
          return;
        }

        // BOTH dimensions, exactly. `pane get` reports viewport_rows and no
        // column count, which would leave this watching rows and arguing that
        // a pty resize carries columns with them. It does -- but `api
        // snapshot` carries the layout, and every pane's rect has a width and
        // a height, so the argument is unnecessary: watch what is at stake.
        const readGeometry = () => {
          try {
            const snap = JSON.parse(cli(['api', 'snapshot'], { HERDR_SESSION: name }));
            for (const layout of snap.result.snapshot.layouts || []) {
              for (const pane of layout.panes || []) {
                if (pane.pane_id !== paneId) continue;
                const r = pane.rect || {};
                if (typeof r.width === 'number' && typeof r.height === 'number') {
                  return `${r.width}x${r.height}`;
                }
              }
            }
            return null;
          } catch (e) { return null; }
        };

        // Settling alone is not enough, and the gap is a timing assumption
        // worth refusing to make. The pane starts at the pty's size, which is
        // the client's fictional rows=200; the browser's real size arrives a
        // moment later as a resize. Measured here the readings went
        // 200 -> 48 -> 48, so the resize beat the first 500ms poll -- but it
        // did that on a loopback connection, and the iPad this is for sits at
        // the far end of a Tailscale link. Two reads of 200 would have looked
        // exactly as settled as two reads of 48.
        //
        // So the pane must be seen to CHANGE from where it started before any
        // pair of equal readings counts. The thing being waited for is the
        // client's size arriving, and a change is the only observable proof
        // that it did.
        const sizeBy = Date.now() + 8000;
        const first = readGeometry();
        let prev = first;
        let moved = false;
        let settled = false;
        while (Date.now() < sizeBy && !settled) {
          await sleep(POLL_MS);
          const now = readGeometry();
          if (now !== null && now !== first) moved = true;
          settled = moved && now !== null && now === prev;
          prev = now;
        }
        // Timing out is not a reason to leave the session without Claude: a
        // mis-sized pane reflows, an empty one never starts. This is also the
        // path taken by a session no browser ever attaches to -- nothing will
        // resize it, so the 8s is the cost of being sure rather than a fault.
        if (!settled) {
          audit('WARN', `${name}: pane never resized from ${first}; starting Claude anyway`);
        }

        try { cli(['pane', 'run', paneId, 'claude'], { HERDR_SESSION: name }); }
        catch (e) {
          audit('ERROR', 'Claude launch failed for session ' + id + ': ' + e.message);
        }
      })();
    },

    // node-pty's ConPTY kill path spawns a console-list helper that dies with
    // "AttachConsole failed" on Windows, so killing the pty directly is noisy
    // at best. Stopping the session (kill()) makes the client fall out on its
    // own; this is only the backstop for a client that did not notice.
    closeProc(proc) {
      setTimeout(() => {
        try { proc.kill(); } catch (e) { audit('WARN', 'herdr proc.kill: ' + e.message); }
      }, 3000);
    },

    kill(id) {
      const name = sessionName(id);
      try {
        cli(['session', 'stop', name, '--json']);
      } catch (e) {
        audit('WARN', `herdr session stop failed for ${name}: ${e.message}`);
      }
      try {
        cli(['session', 'delete', name, '--json']);
      } catch (e) {
        audit('WARN', `herdr session delete failed for ${name}: ${e.message}`);
      }
    },

    // One CLI round trip, the same shape as the dtach probe: is the backend
    // reachable, and is every session we believe in actually running?
    probe(ids) {
      let sessions;
      try {
        sessions = listSessions();
      } catch (e) {
        const why = String(e.stderr || e.message || '').replace(/\0/g, '').trim().split('\n')[0];
        available = false;
        return { ok: false, transportDown: true, detail: `herdr unreachable: ${why.slice(0, 120)}` };
      }
      // The socket API answered, so the backend is reachable -- this is what
      // keeps /health current between init probes.
      available = true;
      const running = new Set(sessions.filter(s => s.running === true).map(s => s.name));
      const orphaned = ids.filter(id => !running.has(sessionName(id)));
      if (orphaned.length) {
        return {
          ok: false, transportDown: false,
          detail: `no live herdr session for ${orphaned.map(id => sessionName(id)).join(', ')}`,
        };
      }
      const ours = [...running].filter(n => n.startsWith(`${PREFIX}-`)).length;
      return { ok: true, transportDown: false, detail: `herdr reachable, ${ours} live session(s)` };
    },
  };
};
