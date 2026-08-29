#!/usr/bin/env node
// P2.1 -- the crash watch for the herdr soak.
//
// WHY THIS EXISTS, precisely: on 29 August the tracker read four days of
// clean herdr logs as an encouraging stability signal. It was not one. The
// instance had had no authenticated use since 25 August and its herdr log was
// 70 lines over six days, all INFO. Zero crash-shaped lines is what an UNUSED
// process looks like, and nothing in the system could tell the two apart.
//
// So this watch is built around one rule: a quiet week and an unwatched week
// must never produce the same artifact. Every tick is recorded, including the
// boring ones, and the summary reports COVERAGE -- how much of the wall clock
// was actually observed -- beside the crash count. A crash count of zero
// means nothing without the coverage number next to it.
//
//   npm run watch:start        # under PM2, survives a reboot with the rest
//   npm run watch              # in the foreground
//   npm run watch:summary      # read the verdict
//
// Starting it belongs with the flip to herdr: watching an idle instance
// reproduces exactly the measurement this replaces.
//
// Writes JSONL to ~/.claude-mobile-crashwatch.jsonl (override with --out).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const DEFAULT_OUT = path.join(HOME, '.claude-mobile-crashwatch.jsonl');
const HERDR_BIN = process.env.HERDR_BIN ||
  path.join(HOME, 'tools', 'herdr', 'herdr.exe');

// What a herdr abort looks like in its own log. The Linux run on 17 August
// produced 45 of these in a day; the Windows build has produced none, which
// is the thing under test. Matched case-insensitively against whole lines.
// Every abort keeps its timestamp, always -- that is what the objective
// names, and a dropped abort loses it entirely. Only the LINE TEXT is capped,
// because the text is the unbounded part; past this many lines in a single
// poll the entries remain, carrying `at` and `atSource` without `line`.
// The worst day on record was 45 aborts in 24h, so this is headroom, not a
// working limit.
const MAX_ABORT_LINES = 200;

const CRASH_PATTERNS = [
  /\bSIGABRT\b/i,
  /\bpanic(ked)?\b/i,
  /\bfatal\b/i,
  /^\s*\S+\s+ERROR\b/,          // tracing-style level column
  /\bthread '[^']*' panicked\b/,
  /\bassertion failed\b/i,
];

function parseArgs(argv) {
  const a = { ports: [], intervalMs: 60000, out: DEFAULT_OUT, summary: false, once: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.ports.push(Number(argv[++i]));
    else if (k === '--interval') a.intervalMs = Number(argv[++i]) * 1000;
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--summary') a.summary = true;
    else if (k === '--once') a.once = true;
  }
  if (!a.ports.length) a.ports = [3457];
  return a;
}

// Liveness must be askable WITHOUT a token: a restart drops every session
// token, so an authenticated probe would report "the server never came back"
// about a server that came back fine (CLAUDE.md, Gotchas).
function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '::1', port, path: '/health', timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ reachable: true, ...JSON.parse(body) }); }
        catch (e) { resolve({ reachable: true, parseError: true }); }
      });
    });
    req.on('error', () => resolve({ reachable: false }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, timeout: true }); });
  });
}

// herdr's own view. Throws rather than returning [] -- "herdr could not be
// asked" is not "there are no sessions", and collapsing them is precisely the
// mistake the session backend was written to avoid.
function listHerdrSessions() {
  const raw = execFileSync(HERDR_BIN, ['session', 'list', '--json'], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.sessions)) throw new Error('no sessions array');
  return parsed.sessions;
}

// A partial line held between polls. herdr writes its log continuously, so a
// poll lands mid-line often; splitting the bytes as they arrive would cut an
// abort in half and neither half would match. Bounded, because an unbounded
// line must not become an unbounded buffer.
const MAX_CARRY_BYTES = 65536;

// Read only what is NEW since the last tick, so a long log is not rescanned
// and a rotated (shrunk) log is noticed rather than silently re-read.
// `carry` is the incomplete tail from the previous read, prepended here.
function scanLogTail(file, lastSize, carry) {
  let st;
  try { st = fs.statSync(file); }
  catch (e) { return { size: lastSize, lines: [], carry: carry || '', state: 'absent' }; }
  if (st.size < lastSize) {
    // Truncated or rotated. Re-read from the top: whatever happened, the
    // bytes we had are gone and pretending otherwise loses events. The carry
    // belonged to those bytes, so it goes with them.
    lastSize = 0;
    carry = '';
  }
  if (st.size === lastSize) {
    return { size: st.size, lines: [], carry: carry || '', state: 'unchanged' };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - lastSize;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, lastSize);
    const text = (carry || '') + buf.toString('utf8');
    const parts = text.split('\n');
    // The last element is whatever followed the final newline: '' if the read
    // ended cleanly, otherwise the start of a line still being written.
    let tail = parts.pop();
    if (tail.length > MAX_CARRY_BYTES) tail = tail.slice(-MAX_CARRY_BYTES);
    return { size: st.size, lines: parts.filter(Boolean), carry: tail, state: 'grew' };
  } finally {
    fs.closeSync(fd);
  }
}

// Watch state outlives the watcher on purpose. A week-long soak spans
// reboots, and an offset that resets to zero re-reports the whole log as
// fresh aborts while a lost everRunning set misses the death it existed to
// catch. Both failures are silent, which is the class this tool is for.
function statePath(out) { return out + '.state'; }

function loadState(out) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(out), 'utf8'));
    return {
      tick: s.tick || 0, lastTickAt: s.lastTickAt || null,
      logs: s.logs || {}, everRunning: s.everRunning || {},
      observedMs: 0, gapMs: 0, gaps: 0, crashTicks: 0, verdicts: {},
      resumed: true,
    };
  } catch (e) {
    return {
      tick: 0, lastTickAt: null, logs: {}, everRunning: {},
      observedMs: 0, gapMs: 0, gaps: 0, crashTicks: 0, verdicts: {},
      resumed: false,
    };
  }
}

function saveState(out, state) {
  try {
    fs.writeFileSync(statePath(out), JSON.stringify({
      tick: state.tick, lastTickAt: state.lastTickAt,
      logs: state.logs, everRunning: state.everRunning,
    }));
  } catch (e) { /* the record itself is the artifact; state is an optimisation */ }
}

function crashLines(lines) {
  return lines.filter(l => CRASH_PATTERNS.some(p => p.test(l)));
}

// The objective is "record every abort WITH A TIMESTAMP", so the abort's own
// stamp is used where the line carries one -- herdr writes ISO-8601 at the
// head of every line -- and the tick time only stands in when it does not.
// Which of the two it was is recorded, because a stand-in timestamp is an
// approximation and a reader should not have to guess that it is.
const ISO_HEAD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/;

function abortsFrom(lines, tickIso) {
  return crashLines(lines).map((line) => {
    const m = ISO_HEAD.exec(line);
    return {
      at: m ? m[1] : tickIso,
      atSource: m ? 'log' : 'tick',
      line: line.length > 400 ? line.slice(0, 400) + '...' : line,
    };
  });
}

async function tick(state, args) {
  const now = Date.now();
  const rec = { t: new Date(now).toISOString(), tick: ++state.tick };

  // A gap is a first-class observation. If the watcher was down, the week has
  // a hole in it and the summary has to say so rather than average it away.
  if (state.lastTickAt) {
    const gapMs = now - state.lastTickAt;
    rec.sinceLastMs = gapMs;
    if (gapMs > args.intervalMs * 2.5) {
      rec.gap = true;
      state.gapMs += gapMs;
      state.gaps++;
    } else {
      state.observedMs += gapMs;
    }
  }
  state.lastTickAt = now;

  rec.servers = {};
  for (const port of args.ports) {
    const h = await getHealth(port);
    rec.servers[port] = h.reachable
      ? { up: true, backend: h.backend, sessions: h.sessions,
          backendAvailable: h.backendAvailable, lastError: h.lastError || null }
      : { up: false };
  }

  let sessions = null;
  try {
    sessions = listHerdrSessions();
    rec.herdr = { asked: true, sessions: {} };
  } catch (e) {
    // Not "no sessions". Unknown, and recorded as unknown.
    rec.herdr = { asked: false, error: String(e.message).slice(0, 160) };
  }

  let crashes = [];
  let vanished = [];
  let logAbsent = [];
  if (sessions) {
    for (const s of sessions) {
      if (s.default) continue;   // the operator's own session, not ours
      const logFile = path.join(s.session_dir, 'herdr-server.log');
      const prev = state.logs[s.name] || { size: 0, carry: '' };
      const scan = scanLogTail(logFile, prev.size, prev.carry);
      state.logs[s.name] = { size: scan.size, carry: scan.carry };
      const bad = abortsFrom(scan.lines, rec.t);
      if (bad.length) {
        // Every abort is kept. Beyond the cap the entry keeps its timestamp
        // and loses only its text, so the count is never a sample and the
        // record never claims a completeness it does not have.
        let dropped = 0;
        const aborts = bad.map((a, i) => {
          if (i < MAX_ABORT_LINES) return a;
          dropped++;
          return { at: a.at, atSource: a.atSource, lineOmitted: true };
        });
        const entry = { session: s.name, count: bad.length, aborts };
        if (dropped) entry.textOmitted = dropped;
        crashes.push(entry);
      }
      // A log that is not there is not a log with nothing in it. A session can
      // be running while its log is missing, and calling that 'ok' would be
      // the collapse this whole file exists to prevent.
      if (scan.state === 'absent') logAbsent.push(s.name);
      rec.herdr.sessions[s.name] = {
        running: !!s.running, logBytes: scan.size, logState: scan.state,
        newLines: scan.lines.length, crashLines: bad.length,
      };
      // A session we have seen running that is no longer running, and that
      // nobody asked us to stop, is the event this watch exists to catch.
      // Reported ONCE: a session that is still gone next tick is not new
      // information, and repeating it would bury the moment it happened.
      if (state.everRunning[s.name] && !s.running) {
        // A process that aborts mid-write leaves its last line unterminated,
        // and an unterminated line is never scanned -- it is held as carry
        // waiting for a newline that is not coming. So when a session goes,
        // its carry is flushed and judged: that final fragment is exactly
        // where the reason for the going tends to be.
        const finalAborts = abortsFrom([prev.carry || ''].filter(Boolean), rec.t);
        if (finalAborts.length) {
          crashes.push({
            session: s.name, count: finalAborts.length, aborts: finalAborts,
            fromUnterminatedTail: true,
          });
        }
        vanished.push(s.name);
        delete state.everRunning[s.name];
      }
      if (s.running) state.everRunning[s.name] = true;
    }
    for (const name of Object.keys(state.everRunning)) {
      if (!sessions.some(s => s.name === name)) {
        vanished.push(name + ' (record gone)');
        delete state.everRunning[name];
      }
    }
  }

  if (crashes.length) rec.crashes = crashes;
  if (vanished.length) rec.vanished = vanished;
  if (logAbsent.length) rec.logAbsent = logAbsent;

  // Verdicts are deliberately not collapsed.
  //
  // 'crash' means herdr's own log said so, which is evidence. 'vanished'
  // means a session that was running is not -- which an ABORT produces, and
  // so does the operator stopping it on purpose. Nothing at this layer can
  // tell those apart, so it gets its own verdict rather than borrowing
  // 'crash': condemning a week-long soak because the operator restarted
  // something would be worse than saying plainly what was seen.
  //
  // 'unknown' is never folded into 'ok' either: a tick where herdr could not
  // be asked, or where a running session's log was missing, is not a tick
  // where herdr was fine.
  if (crashes.length) rec.verdict = 'crash';
  else if (vanished.length) rec.verdict = 'vanished';
  else if (!sessions || logAbsent.length) rec.verdict = 'unknown';
  else if (args.ports.some(p => !rec.servers[p].up)) rec.verdict = 'degraded';
  else rec.verdict = 'ok';

  state.verdicts[rec.verdict] = (state.verdicts[rec.verdict] || 0) + 1;
  if (rec.verdict === 'crash') state.crashTicks++;

  fs.appendFileSync(args.out, JSON.stringify(rec) + '\n');
  return rec;
}

function summarise(out) {
  let lines;
  try { lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean); }
  catch (e) {
    console.log('NO WATCH DATA at ' + out);
    console.log('Nothing has been observed. This is NOT the same as "no crashes".');
    return 1;
  }
  const recs = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
  if (!recs.length) {
    console.log('watch file exists but holds no readable records: ' + out);
    return 1;
  }
  const first = recs[0], last = recs[recs.length - 1];
  const spanMs = new Date(last.t) - new Date(first.t);
  const gapMs = recs.filter(r => r.gap).reduce((a, r) => a + (r.sinceLastMs || 0), 0);
  const observedMs = Math.max(0, spanMs - gapMs);
  const counts = {};
  for (const r of recs) {
    if (!r.verdict) continue;   // watch-start / watch-error carry no verdict
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  }
  const events = recs.filter(r => r.event).length;
  const crashRecs = recs.filter(r => r.verdict === 'crash');
  const vanishRecs = recs.filter(r => r.verdict === 'vanished');
  // Count ABORTS, not the ticks that carried them: several can land in one
  // poll, and a tick count would understate the failure it is reporting.
  let abortCount = 0, truncated = 0, vanishCount = 0;
  for (const r of crashRecs) {
    for (const c of r.crashes || []) {
      abortCount += (c.count !== undefined ? c.count : (c.aborts || []).length);
      truncated += c.textOmitted || 0;   // the writer's field name
    }
  }
  for (const r of vanishRecs) vanishCount += (r.vanished || []).length;
  // A duration printed in the wrong unit reads as zero. Pick the unit from
  // the value so a short window is legible and a week-long one stays compact.
  const dur = (ms) => ms >= 3600000 ? (ms / 3600000).toFixed(1) + 'h'
    : ms >= 60000 ? (ms / 60000).toFixed(1) + 'm'
    : (ms / 1000).toFixed(0) + 's';

  console.log('herdr crash watch -- ' + out);
  console.log('  window     : ' + first.t + '  ->  ' + last.t);
  console.log('  ticks      : ' + (recs.length - events) + '  ' + JSON.stringify(counts) +
              (events ? '  (+' + events + ' watch event(s))' : ''));
  // Coverage is reported first and always, because a crash count without it
  // is the exact number that misled this project once already.
  console.log('  COVERAGE   : ' + dur(observedMs) + ' observed of ' + dur(spanMs) +
              ' elapsed  (' + (spanMs ? Math.round(observedMs / spanMs * 100) : 0) + '%)' +
              (gapMs ? '  -- ' + dur(gapMs) + ' UNWATCHED' : ''));
  console.log('  aborts     : ' + abortCount + ' in herdr\'s log, across ' +
              crashRecs.length + ' tick(s)' +
              (truncated ? '  -- ' + truncated + ' stored without their text' : ''));
  console.log('  vanished   : ' + vanishCount +
              ' session(s) that were running and stopped being' +
              (vanishCount ? '  -- a deliberate stop looks identical; confirm' : ''));
  for (const r of crashRecs.concat(vanishRecs).slice(-5)) {
    const what = (r.crashes || []).map(c =>
      c.session + ' x' + c.count + ' @ ' + (c.aborts[0] && c.aborts[0].at));
    console.log('    ' + r.t + '  ' + JSON.stringify(what.length ? what : r.vanished));
  }
  if (counts.unknown) {
    console.log('  NOTE       : ' + counts.unknown +
                ' tick(s) could not ask herdr -- those are unknown, not clean');
  }
  console.log('');
  if (crashRecs.length) {
    console.log('VERDICT: CRASHES OBSERVED -- P2 has its answer, and it is no.');
  } else if (vanishRecs.length) {
    console.log('VERDICT: ' + vanishCount + ' SESSION DISAPPEARANCE(S), no log abort.');
    console.log('         An abort and a deliberate stop are indistinguishable from');
    console.log('         here. Confirm which before reading this either way.');
  } else if (spanMs && observedMs / spanMs < 0.9) {
    console.log('VERDICT: INSUFFICIENT COVERAGE -- too much of the window was unwatched');
    console.log('         to call it clean. Zero crashes here is not evidence yet.');
  } else {
    console.log('VERDICT: clean over ' + dur(observedMs) + ' of observed time.');
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.summary) return summarise(args.out);

  const state = loadState(args.out);

  // Announce the start in the record itself, so a reader can always tell
  // when observation actually began rather than inferring it.
  fs.appendFileSync(args.out, JSON.stringify({
    t: new Date().toISOString(), event: 'watch-start',
    ports: args.ports, intervalMs: args.intervalMs, pid: process.pid,
    resumed: state.resumed, fromTick: state.tick,
  }) + '\n');

  const run = async () => {
    try {
      const rec = await tick(state, args);
      saveState(args.out, state);
      if (rec.verdict === 'crash') {
        console.error('[crash-watch] CRASH at ' + rec.t + ' ' +
                      JSON.stringify(rec.crashes));
      } else if (rec.verdict === 'vanished') {
        console.error('[crash-watch] SESSION VANISHED at ' + rec.t + ' ' +
                      JSON.stringify(rec.vanished) +
                      ' -- an abort and a deliberate stop look identical here');
      }
    } catch (e) {
      // The watch failing silently would reproduce the exact problem it was
      // built to solve, so its own failures are records too.
      try {
        fs.appendFileSync(args.out, JSON.stringify({
          t: new Date().toISOString(), event: 'watch-error',
          error: String(e.message).slice(0, 300),
        }) + '\n');
      } catch (_) { /* the disk is gone; nothing useful left to do */ }
      console.error('[crash-watch] tick failed: ' + e.message);
    }
  };

  await run();
  if (args.once) return 0;
  setInterval(run, args.intervalMs);
  return new Promise(() => {});   // run until stopped
}

if (require.main === module) {
  main().then(c => { if (typeof c === 'number') process.exit(c); });
}

module.exports = {
  CRASH_PATTERNS, crashLines, abortsFrom, scanLogTail, summarise,
  loadState, saveState, statePath, MAX_ABORT_LINES,
};
