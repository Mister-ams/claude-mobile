/**
 * dtach session backend -- the shipped default.
 *
 * Claude Code runs inside a dtach daemon in WSL Ubuntu; node-pty spawns
 * wsl.exe to attach to it. dtach does no terminal emulation, so xterm.js and
 * the headless mirror get raw pty output, and the daemon survives PM2/node
 * restarts because it lives in WSL rather than in this process tree.
 *
 * Moved out of server.js unchanged apart from the four-valued state() (see
 * ../session-backend/index.js for why 'unknown' is not 'gone'). The security
 * reasoning in the comments below was paid for in a real audit -- read it
 * before touching argv construction.
 */

const { execFileSync } = require('child_process');

module.exports = function createDtachBackend({ config, audit, getSafeEnv, pty, setLastError }) {
  const WSL_DISTRO = config.wslDistro || 'Ubuntu-24.04';
  const DTACH_DIR = '/tmp';
  // Socket files: /tmp/cm-0.dtach, cm-1.dtach, ...
  //
  // Configurable because a SECOND server pointed at the same prefix adopts the
  // live server's sessions on startup -- recovery scans the prefix, not the
  // port. That has happened once already: a test instance on another port took
  // over cm-0. Any instance that is not the live service gets its own prefix.
  const PREFIX = config.sessionPrefix || 'cm';

  let wslAvailable = false;

  // T23 (N1): every WSL call goes through execFileSync with an argv array. The
  // old wslExec built one command string --
  //   execSync(`wsl -d ${D} -u root -- bash -c "${cmd.replace(/"/g,'\\"')}"`)
  // -- escaping double quotes only, and routed it through cmd.exe, which does not
  // honour \" as an escape; backticks and $() also expanded inside the
  // double-quoted bash string. Nothing client-reachable fed it (project dirs are
  // allowlist-checked by exact match and session ids are numeric Map keys), but a
  // project directory containing a backtick, $ or & made it root RCE inside WSL.
  // execFileSync launches the binary directly: no cmd.exe, no shell parsing of
  // our arguments on the Windows side.
  //
  // It also has to be `--exec`, not `--`. `wsl.exe -- <cmd>` does NOT exec the
  // command: it joins everything after `--` into one string and hands that to the
  // default login shell, which re-parses it. Measured on Ubuntu-24.04:
  //   --      bash -c 'printf "%s|" "$0" "$@"' A B  ->  "/bin/bash||"
  //   --exec  bash -c 'printf "%s|" "$0" "$@"' A B  ->  "A|B|"
  // Under `--` the positional parameters never arrive because the outer shell
  // consumed them, which also means the old code had TWO shell layers -- cmd.exe's
  // and that one -- and a single round of quote escaping could not survive either.
  // `--exec` is the documented no-shell form: $(), backticks, &, | and spaces all
  // arrive literally.
  function wslRun(argv, opts = {}) {
    return execFileSync('wsl.exe', ['-d', WSL_DISTRO, ...argv], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, ...opts,
    }).trim();
  }

  // Where bash is genuinely needed (globs, ||, redirection) the script text is a
  // FIXED literal and every value arrives as a positional parameter: data to
  // bash, never syntax. $0 is a label, so the first param is $1.
  function wslBash(script, params = []) {
    return wslRun(['-u', 'root', '--exec', 'bash', '-c', script, 'claude-mobile', ...params.map(String)]);
  }

  function winPathToWsl(winPath) {
    return winPath
      .replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`)
      .replace(/\\/g, '/');
  }

  function socketFor(id) { return `${DTACH_DIR}/${PREFIX}-${id}.dtach`; }

  function probeWSL() {
    try {
      wslRun(['--exec', 'echo', '1'], { timeout: 5000 });
      wslAvailable = true;
      return true;
    } catch (e) {
      wslAvailable = false;
      setLastError(`WSL probe failed: ${e.message}`);
      return false;
    }
  }

  // Liveness means a process is HOLDING the socket, not merely that the file
  // exists. /tmp is on the ext4 rootfs in this distro rather than tmpfs, so socket
  // FILES survive a WSL shutdown while the daemons behind them do not: the old
  // `test -S` reported those phantoms as alive and recovery attached to nothing --
  // exactly the case the boot-resilience work makes routine. lsof is already how
  // kill() finds the holder, so reuse it rather than invent a second mechanism.
  function socketState(socket) {
    return wslBash(
      'if [ ! -S "$1" ]; then echo gone; ' +
      'elif [ -n "$(lsof -t "$1" 2>/dev/null)" ]; then echo alive; ' +
      'else echo stale; fi',
      [socket]);
  }

  return {
    kind: 'dtach',

    describe() { return `dtach via WSL (${WSL_DISTRO}), prefix ${PREFIX}-`; },

    label(id) { return `${PREFIX}-${id}`; },

    isAvailable() { return wslAvailable; },

    init() {
      if (probeWSL()) {
        console.log(`[init] WSL (${WSL_DISTRO}) available`);
        return;
      }
      console.warn('[init] WSL not available, retrying in 5s...');
      const retryInterval = setInterval(() => {
        if (probeWSL()) {
          console.log(`[init] WSL (${WSL_DISTRO}) now available`);
          clearInterval(retryInterval);
        }
      }, 5000);
      // Stop retrying after 2 minutes
      setTimeout(() => clearInterval(retryInterval), 120000);
    },

    state(id) {
      const socket = socketFor(id);
      try {
        const s = socketState(socket);
        if (s === 'alive') return 'alive';
        // Re-probe before unlinking: the second WSL round-trip also supplies the
        // spacing, so a socket that was created microseconds ago is not mistaken
        // for a phantom during create()'s attach retry loop.
        if (s === 'stale' && socketState(socket) === 'stale') {
          // Nothing holds it, so unlinking cannot orphan a live session -- and a
          // socket that still HAS a holder is never touched here.
          audit('SESSION', `Stale dtach socket with no holder removed: ${PREFIX}-${id}`);
          try { wslBash('rm -f "$1"', [socket]); }
          catch (e) { audit('WARN', `stale socket unlink failed for ${PREFIX}-${id}: ${e.message}`); }
          return 'stale';
        }
        return s === 'gone' ? 'gone' : 'stale';
      } catch (e) {
        // WSL could not be reached, so nothing was learned about this session.
        // Reporting 'gone' here would delete a live session on a transient
        // hiccup; the caller retries instead.
        audit('WARN', 'dtach state: ' + e.message);
        return 'unknown';
      }
    },

    alive(id) { return this.state(id) === 'alive'; },

    list() {
      try {
        const out = wslBash('ls "$1"/"$2"-*.dtach 2>/dev/null || true', [DTACH_DIR, PREFIX]);
        if (!out) return { live: [], phantom: [] };
        const re = new RegExp(`${PREFIX}-(\\d+)\\.dtach$`);
        const ids = out.split('\n').filter(Boolean).map(p => {
          const match = p.match(re);
          return match ? parseInt(match[1]) : null;
        }).filter(id => id !== null);
        // A socket file with no process behind it is a phantom -- routine after a
        // WSL restart, since /tmp is on the rootfs here. state() reports it and
        // clears it, so the leftover heals on read instead of being attached to.
        const live = [], phantom = [];
        for (const id of ids) (this.state(id) === 'alive' ? live : phantom).push(id);
        return { live, phantom };
      } catch (e) {
        audit('ERROR', 'dtach list failed (WSL may be down): ' + e.message);
        return { live: [], phantom: [] };
      }
    },

    // Create dtach session as daemon (dtach -n), then attach via node-pty.
    // dtach -n runs bash as a daemon -- survives PM2/node restarts.
    // cmd.exe can't run under dtach -n directly (Windows interop needs a
    // real terminal), so we create a bash shell first, attach, then send
    // the claude command via the pty.
    async create(id, { dir, cols, rows }) {
      const wslDir = winPathToWsl(dir);
      try {
        // $1 = project dir, $2 = socket. Both are parameters, so a directory
        // containing a backtick, $ or & is a literal path, not shell syntax.
        wslBash('cd "$1" && exec env TERM=xterm-256color dtach -n "$2" -z bash',
          [wslDir, socketFor(id)]);
      } catch (e) {
        audit('ERROR', `dtach create failed: ${e.message}`);
        return null;
      }

      // Wait for the dtach socket to appear (retry with async delay).
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (this.state(id) === 'alive') return this.attach(id, { cols, rows });
        } catch (e) { lastErr = e; }
        await new Promise(r => setTimeout(r, 300));
      }
      audit('ERROR', `dtach attach failed after 5 retries: ${lastErr?.message || 'unknown'}`);
      return null;
    },

    // Attach to an existing dtach session via node-pty
    attach(id, { cols, rows }) {
      // --exec for the same reason as wslRun: `--` would route the socket path
      // through the distro's login shell before dtach ever sees it.
      return pty.spawn('wsl.exe', [
        '-d', WSL_DISTRO, '-u', 'root', '--exec',
        'dtach', '-a', socketFor(id)
      ], {
        name: 'xterm-256color', cols: cols || 80, rows: rows || 24,
        env: getSafeEnv()
      });
    },

    // bash is running inside dtach; Claude is launched through Windows interop
    // so it uses the existing Windows auth rather than a second WSL login.
    // dims are accepted for interface parity and ignored: a dtach daemon is
    // created at the size the pty attaches with, so there is nothing to wait for.
    launchClaude(proc, id) {
      setTimeout(() => {
        try { proc.write('cmd.exe /c claude\r'); } catch (e) {
          audit('ERROR', 'Claude launch write failed for session ' + id + ': ' + e.message);
        }
      }, 500);
    },

    closeProc(proc) {
      try { proc.kill(); } catch (e) { audit('WARN', 'proc.kill: ' + e.message); }
    },

    kill(id) {
      const socket = socketFor(id);
      try {
        // Find and kill the process attached to this socket. lsof can return
        // several pids; the old code relied on shell word-splitting to kill them
        // all, so keep that behaviour explicitly (and only for numeric pids).
        const found = wslBash('lsof -t "$1" 2>/dev/null || true', [socket]);
        const pids = found.split('\n').map(p => p.trim()).filter(p => /^\d+$/.test(p));
        for (const pid of pids) wslBash('kill "$1" 2>/dev/null || true', [pid]);
        wslBash('rm -f "$1"', [socket]);
      } catch (e) {
        audit('WARN', 'dtach kill failed for ' + id + ': ' + e.message);
      }
    },

    // One WSL round trip: is dtach reachable, and which sockets are actually
    // held by a process?
    probe(ids) {
      try {
        const out = wslBash(
          'command -v dtach >/dev/null 2>&1 || { echo NODTACH; exit 0; }; ' +
          'for s in "$1"/"$2"-*.dtach; do [ -S "$s" ] || continue; ' +
          'if [ -n "$(lsof -t "$s" 2>/dev/null)" ]; then echo "$s"; fi; done',
          [DTACH_DIR, PREFIX]);
        if (out.includes('NODTACH')) {
          return { ok: false, transportDown: false, detail: `dtach is missing in ${WSL_DISTRO}` };
        }
        // The round trip completed, so WSL itself is reachable -- this is the
        // signal /health reports between init probes.
        wslAvailable = true;
        const held = new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
        const orphaned = ids.filter(id => !held.has(socketFor(id)));
        if (orphaned.length) {
          return {
            ok: false, transportDown: false,
            detail: `no live dtach process for ${orphaned.map(id => `${PREFIX}-${id}`).join(', ')}`,
          };
        }
        return { ok: true, transportDown: false, detail: `dtach reachable, ${held.size} live socket(s)` };
      } catch (e) {
        // wsl.exe writes its own errors as UTF-16, so strip the NULs and take the
        // first line; otherwise the whole probe script gets echoed into the log.
        const stderr = String(e.stderr || '').replace(/\0/g, '').trim().split('\n')[0];
        const why = stderr || `exit ${e.status === undefined ? '?' : e.status}`;
        wslAvailable = false;
        return { ok: false, transportDown: true, detail: `WSL (${WSL_DISTRO}) unreachable: ${why.slice(0, 120)}` };
      }
    },
  };
};
