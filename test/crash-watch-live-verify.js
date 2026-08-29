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

// A check that can quietly not run is worse than one that is absent: an
// absent check is a known gap, an inert one is a false belief. This project
// has already shipped that exact failure -- the ORM-drift gate reported
// SKIPPED for months and had never executed. So a skip here is LOUD and
// non-zero unless the caller explicitly accepts it with --allow-skip.
const ALLOW_SKIP = process.argv.includes('--allow-skip');
let pty;
try { pty = require('node-pty'); }
catch (e) {
  console.error('');
  console.error('  NOT RUN  node-pty is not resolvable here, so the live guard');
  console.error('           did NOT execute. This is not a pass. Run it from an');
  console.error('           installed tree, or pass --allow-skip to accept the');
  console.error('           gap deliberately.');
  process.exit(ALLOW_SKIP ? 0 : 2);
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

    // The path the objective actually names: a crash-shaped line appearing in
    // herdr's own log. Written into the THROWAWAY session's log, so a real
    // file is really tailed -- no fixture, no stub, and the operator's own
    // sessions are untouched.
    const dir = (function () {
      try {
        const list = JSON.parse(cli('session', 'list', '--json')).sessions || [];
        const me = list.find(x => x.name === SESSION);
        return me ? me.session_dir : null;
      } catch (e) { return null; }
    })();
    check('the throwaway session has a log to tail', !!dir, dir || '');
    if (dir) {
      const logFile = path.join(dir, 'herdr-server.log');
      const stamp = new Date().toISOString();
      fs.appendFileSync(logFile,
        stamp + " ERROR herdr::server: synthetic abort for T-P2.1 live verification\n" +
        stamp + " thread 'main' panicked at src/live-verify.rs:1:1\n");
      await sleep(13000);
      const withAborts = readRecs(OUT).filter(r => r.verdict === 'crash');
      check('THE WATCH FIRED on crash-shaped lines in a real log',
        withAborts.length >= 1,
        readRecs(OUT).filter(r => r.verdict).map(r => r.verdict).join(','));
      const entry = withAborts[0] && (withAborts[0].crashes || [])[0];
      check('it recorded BOTH abort lines, not a sample',
        !!entry && entry.count === 2, entry ? 'count=' + entry.count : '');
      check('and each abort carries its own timestamp from the log',
        !!entry && entry.aborts.length === 2 &&
        entry.aborts.every(a => a.atSource === 'log'),
        entry ? entry.aborts.map(a => a.atSource).join(',') : '');
    }

    // The other shape: a session that was alive and is not.
    cli('session', 'stop', SESSION);
    await sleep(14000);

    recs = readRecs(OUT).filter(r => r.verdict);
    const gone = recs.filter(r => r.verdict === 'vanished');
    check('THE WATCH FIRED on a session disappearing under it', gone.length >= 1,
      recs.map(r => r.verdict).join(','));
    check('and it named the session that went',
      gone.length > 0 && (gone[0].vanished || []).some(v => v.startsWith(SESSION)),
      gone.length ? JSON.stringify(gone[0].vanished) : '');
    // Reported once. A session that is still gone next tick is not news, and
    // repeating it would bury the moment it happened under its own echo.
    check('and it reported it once, not every tick after',
      gone.length === 1, gone.length + ' vanished tick(s)');
    // A stop we performed deliberately must NOT be filed as an abort -- an
    // operator restarting something mid-soak would otherwise condemn the week.
    check('a deliberate stop is NOT filed as a log abort',
      !gone.some(r => (r.crashes || []).length),
      'verdict=' + (gone[0] && gone[0].verdict));
    check('the failure reached stderr, not just the file',
      /VANISHED/.test(werr), werr.trim().split('\n').slice(-1)[0] || '(nothing on stderr)');
  } finally {
    w.kill();
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
