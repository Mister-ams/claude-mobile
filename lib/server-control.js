/**
 * Server lifecycle control, so the operator does not need the laptop.
 *
 * Two actions, and the reason there are only two is worth stating.
 *
 *   restart  safe and near-invisible. PM2 runs with autorestart, so exiting
 *            IS a restart; the client already reconnects on a 1s backoff, and
 *            sessions survive by design on both backends. The terminal comes
 *            back with its session still in it.
 *
 *   update   pull, install if the manifests moved, restart -- update.sh, run
 *            from a phone. This is the one that removes the trip to the
 *            laptop, which is the whole point.
 *
 * There is deliberately no stop and no start. A stop is a one-way door: the UI
 * is served BY the server, so nothing in it can revive the process, and
 * recovery would mean the laptop or a reboot. And a start cannot exist at all
 * for the same reason -- a button that can never work is worse than an absent
 * one.
 *
 * The old `/api/kill` is gone. It claimed to be a security kill switch, had no
 * caller anywhere in the client, and under PM2 autorestart it did not kill:
 * `process.exit(0)` and PM2 brought the server straight back. It was an
 * undocumented restart wearing a panic button's label.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { orphanSpawn } = require('./orphan-spawn');

// An update that claims to be running for longer than this is not running --
// the machine slept, or the runner was killed. Without a bound, one crashed
// update would refuse every future one forever.
const UPDATE_STALE_MS = 15 * 60 * 1000;
const REMOTE_CHECK_MS = 30 * 60 * 1000;

module.exports = function createServerControl({ config, audit, installDir }) {
  const STATE_PATH = path.join(os.homedir(), '.claude-mobile-update-state.json');
  const LOG_PATH = path.join(os.homedir(), '.claude-mobile-update.log');

  // Read rather than take as a parameter: package.json is the one place the
  // version lives, and after an update this process is running the NEW file,
  // so re-reading is also how the client sees the version change.
  function readVersion() {
    try {
      return JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version;
    } catch (e) { return null; }
  }

  // PM2 exports the app name as `name`. It is what update.sh must restart, and
  // getting it wrong means a second instance restarts the live one.
  const PM2_NAME = config.pm2Name || process.env.name || 'claude-mobile';

  let remote = { head: null, checkedAt: null, error: null };

  function git(args) {
    return execFileSync('git', args, {
      cwd: installDir, encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim();
  }

  function localHead() {
    try { return { head: git(['rev-parse', '--short', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) }; }
    catch (e) { return { head: null, branch: null }; }
  }

  // ls-remote rather than fetch: it answers the same question without writing
  // to the repository, so a background check can never leave the working tree
  // in a state the operator did not ask for.
  function checkRemote() {
    try {
      const out = git(['ls-remote', 'origin', 'master']);
      const sha = (out.split(/\s+/)[0] || '').slice(0, 7);
      remote = { head: sha || null, checkedAt: Date.now(), error: null };
    } catch (e) {
      // Unreachable origin is not "up to date" -- say so rather than let the
      // UI imply the check succeeded.
      remote = { head: null, checkedAt: Date.now(), error: e.message.slice(0, 120) };
    }
    return remote;
  }

  function readUpdateState() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (s.running && Date.parse(s.startedAt) < Date.now() - UPDATE_STALE_MS) {
        return { ...s, running: false, stale: true };
      }
      return s;
    } catch (e) {
      // No file is the normal state before the first update, and an
      // unparseable one tells us nothing -- neither is an error to report.
      return null;
    }
  }

  function resolveBash() {
    if (config.bashPath) return config.bashPath;
    try {
      const found = execFileSync('where', ['bash'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
        .trim().split('\n')[0].trim();
      if (found) return found;
    } catch (e) { /* fall through to the known locations */ }
    for (const p of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      '/bin/bash', '/usr/bin/bash',
    ]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  return {
    pm2Name: PM2_NAME,

    startRemoteChecks() {
      checkRemote();
      const t = setInterval(checkRemote, REMOTE_CHECK_MS);
      if (t.unref) t.unref();
    },

    status() {
      const local = localHead();
      const lastUpdate = readUpdateState();
      return {
        version: readVersion(),
        commit: local.head,
        branch: local.branch,
        pm2Name: PM2_NAME,
        installDir,
        uptime: Math.floor(process.uptime()),
        remote: {
          commit: remote.head,
          checkedAt: remote.checkedAt,
          // An unreachable origin is reported, not swallowed. "unknown" and
          // "up to date" are different answers.
          error: remote.error,
        },
        updateAvailable: !!(remote.head && local.head && remote.head !== local.head),
        updateRunning: !!(lastUpdate && lastUpdate.running),
        lastUpdate: lastUpdate && !lastUpdate.running ? {
          finishedAt: lastUpdate.finishedAt,
          from: lastUpdate.from,
          to: lastUpdate.to,
          exitCode: lastUpdate.exitCode,
          changed: lastUpdate.changed,
          error: lastUpdate.error || null,
          stale: !!lastUpdate.stale,
          tail: lastUpdate.tail || null,
        } : null,
      };
    },

    refresh() { return checkRemote(); },

    restart(ip) {
      audit('SYSTEM', `Restart requested from the client (pm2: ${PM2_NAME})`, ip);
      // Let the HTTP response flush first. PM2 autorestart is what brings the
      // process back; exiting non-zero would look like a crash in its logs.
      setTimeout(() => process.exit(0), 500);
      return { ok: true, pm2Name: PM2_NAME };
    },

    startUpdate(ip) {
      const state = readUpdateState();
      if (state && state.running) {
        return { ok: false, reason: 'An update is already running.' };
      }
      const bashPath = resolveBash();
      if (!bashPath) {
        return { ok: false, reason: 'bash was not found -- set bashPath in config.json.' };
      }
      const runner = path.join(installDir, 'scripts', 'update-runner.js');
      if (!fs.existsSync(runner)) {
        return { ok: false, reason: 'scripts/update-runner.js is missing from this install.' };
      }

      const payload = Buffer.from(JSON.stringify({
        installDir, bashPath, statePath: STATE_PATH, logPath: LOG_PATH, pm2Name: PM2_NAME,
      })).toString('base64');

      // Orphaned, because update.sh restarts THIS process and would otherwise
      // tree-kill the updater partway through. See lib/orphan-spawn.js.
      try {
        orphanSpawn({ command: process.execPath, args: [runner, payload], cwd: installDir });
      } catch (e) {
        return { ok: false, reason: `Could not start the updater: ${e.message}` };
      }
      audit('SYSTEM', `Update requested from the client (pm2: ${PM2_NAME})`, ip);
      return { ok: true, pm2Name: PM2_NAME };
    },
  };
};
