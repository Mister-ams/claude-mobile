/**
 * Runs update.sh on behalf of the server, from outside the server's life.
 *
 * update.sh ends by restarting the PM2 process -- which is the server that
 * asked for the update. If this ran as a child of that server it would be
 * tree-killed partway through, and the most likely moment for that is during
 * `npm ci`: npm wipes node_modules alphabetically and node-pty carries a
 * native binary the live server holds open, so a kill mid-wipe leaves the tree
 * half-deleted and invisibly broken until the next restart. That is a real
 * gotcha in this repo, not a hypothetical.
 *
 * So the server orphans this process first (lib/orphan-spawn.js) and it
 * outlives the restart, writing what happened to a state file the server reads
 * once it is back up. Nothing is streamed to the client, because the client's
 * connection does not survive either.
 *
 * argv[2] is base64 JSON: { installDir, bashPath, statePath, logPath, pm2Name }
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());

function gitHead(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).trim();
  } catch (e) { return null; }
}

function writeState(state) {
  try {
    fs.writeFileSync(cfg.statePath, JSON.stringify(state, null, 2));
  } catch (e) {
    // Nothing to report to -- the server is restarting. Leave a trace in the
    // log, which is the only channel that outlives this process.
    try { fs.appendFileSync(cfg.logPath, `\n[runner] state write failed: ${e.message}\n`); }
    catch (e2) { /* give up quietly rather than crash the updater */ }
  }
}

const from = gitHead(cfg.installDir);
const startedAt = new Date().toISOString();

writeState({ running: true, startedAt, from, pm2Name: cfg.pm2Name });

// Truncate rather than append: the state file points at "the last update", and
// a log that accumulates every run makes the tail meaningless.
try { fs.writeFileSync(cfg.logPath, `[runner] ${startedAt} updating ${cfg.installDir}\n`); }
catch (e) { /* the update is still worth attempting without a log */ }

const out = fs.openSync(cfg.logPath, 'a');
const child = spawn(cfg.bashPath, ['update.sh'], {
  cwd: cfg.installDir,
  // CM_PM2_NAME tells update.sh which PM2 process to restart. Without it the
  // script restarts the one called "claude-mobile" -- so an update triggered
  // from a second instance would restart the LIVE server instead of itself.
  env: { ...process.env, CM_PM2_NAME: cfg.pm2Name || 'claude-mobile' },
  stdio: ['ignore', out, out],
  windowsHide: true,
});

child.on('error', (e) => {
  writeState({
    running: false, startedAt, finishedAt: new Date().toISOString(),
    from, to: from, exitCode: null, error: e.message, pm2Name: cfg.pm2Name,
  });
});

child.on('close', (code) => {
  const to = gitHead(cfg.installDir);
  let tail = '';
  try {
    const log = fs.readFileSync(cfg.logPath, 'utf8').split('\n');
    tail = log.slice(-12).join('\n');
  } catch (e) { /* the exit code still carries the verdict */ }
  writeState({
    running: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    from,
    to,
    // update.sh exits non-zero when it finished DEGRADED, so this is not
    // merely "did it crash" -- it is the script's own verdict.
    exitCode: code,
    changed: !!(from && to && from !== to),
    tail,
    pm2Name: cfg.pm2Name,
  });
  try { fs.closeSync(out); } catch (e) { /* already gone */ }
  process.exit(0);
});
