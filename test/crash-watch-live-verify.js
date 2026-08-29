#!/usr/bin/env node
// P2.1 live verification -- watch the crash watch FIRE.
//
// crash-watch-verify.js proves the pieces against synthetic input. That is
// necessary and not sufficient: this project's own record is full of guards
// that passed their unit tests and had never once executed for real. The
// acceptance standard here is "have I watched it fail?", and a guard nobody
// has seen fire is a false belief rather than a protection.
//
// So this creates a REAL herdr session, lets the watch see it running, then
// stops it out from under the watch, and asserts the watch called it. It also
// asserts the watch was CLEAN first -- a detector that fires on everything
// would pass the second half and be useless.
//
//   node test/crash-watch-live-verify.js
//
// Needs herdr on PATH (or HERDR_BIN) and node-pty resolvable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BIN = process.env.HERDR_BIN ||
  path.join(os.homedir(), 'tools', 'herdr', 'herdr.exe');
const SESSION = 'cmwatchlive';
const WATCH = path.join(__dirname, '..', 'scripts', 'crash-watch.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = Object.assign({}, process.env, { HERDR_SESSION: SESSION });

function cli(...a) {
  try {
    return execFileSync(BIN, a, {
      encoding: 'utf8', env, timeout: 25000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) { return ''; }
}
function cleanup() { cli('session', 'stop', SESSION); cli('session', 'delete', SESSION); }
function readRecs(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

let pty;
try { pty = require('node-pty'); }
catch (e) {
  console.log('  SKIP  node-pty not resolvable -- run from an installed tree');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwlive-'));
const OUT = path.join(tmp, 'watch.jsonl');

(async () => {
  console.log('\n=== the watch, against a real herdr session ===');
  cleanup();

  const proc = pty.spawn(BIN, ['--session', SESSION], {
    name: 'xterm-256color', cols: 100, rows: 30,
    cwd: process.cwd(), env,
  });
  proc.onData(() => {});
  await sleep(6000);
  const up = /cmwatchlive\s+running/.test(cli('session', 'list'));
  check('a throwaway herdr session is running', up);
  if (!up) { cleanup(); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }

  const w = spawn(process.execPath,
    [WATCH, '--port', '3457', '--interval', '5', '--out', OUT],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let werr = '';
  w.stderr.on('data', d => { werr += d; });

  try {
    await sleep(13000);
    let recs = readRecs(OUT).filter(r => r.verdict);
    check('the watch saw the session and called it clean',
      recs.length >= 2 && recs.every(r => r.verdict === 'ok'),
      recs.map(r => r.verdict).join(','));
    check('and it recorded the session as running, not merely absent',
      recs.some(r => r.herdr && r.herdr.sessions && r.herdr.sessions[SESSION] &&
        r.herdr.sessions[SESSION].running === true));

    // The event P2 exists to catch: a session that was alive and is not.
    cli('session', 'stop', SESSION);
    await sleep(14000);

    recs = readRecs(OUT).filter(r => r.verdict);
    const crashes = recs.filter(r => r.verdict === 'crash');
    check('THE WATCH FIRED on a session dying under it', crashes.length >= 1,
      recs.map(r => r.verdict).join(','));
    check('and it named the session that died',
      crashes.length > 0 && (crashes[0].vanished || []).some(v => v.startsWith(SESSION)),
      crashes.length ? JSON.stringify(crashes[0].vanished) : '');
    // Reported once. A session that is still gone next tick is not news, and
    // repeating it would bury the moment it happened under its own echo.
    check('and it reported the death once, not every tick after it',
      crashes.length === 1, crashes.length + ' crash tick(s)');
    check('the failure reached stderr, not just the file',
      /CRASH/.test(werr), werr.trim().split('\n')[0] || '(nothing on stderr)');

    // Having watched it fail, watch it recover: the ticks after the one-shot
    // report must go back to clean rather than latching red forever.
    const afterCrash = recs.slice(recs.indexOf(crashes[0]) + 1);
    check('it returns to clean afterwards rather than latching',
      afterCrash.length > 0 && afterCrash.every(r => r.verdict !== 'crash'),
      afterCrash.map(r => r.verdict).join(',') || '(no ticks after)');
  } finally {
    w.kill();
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
