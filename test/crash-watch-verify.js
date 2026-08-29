#!/usr/bin/env node
// Verification for the P2.1 crash watch.
//
// The standard this has to meet is the one the watch itself exists to
// enforce: it is not enough that it passes. It has to be WATCHED FAILING --
// shown a real crash-shaped log and seen to call it a crash, and shown a gap
// in its own coverage and seen to refuse to call the window clean.
//
//   node test/crash-watch-verify.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  crashLines, abortsFrom, scanLogTail, summarise,
  loadState, saveState, statePath, MAX_ABORTS_PER_TICK,
} = require('../scripts/crash-watch');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));

// ─── crash-shape detection ───────────────────────────────────────
console.log('\n=== does it recognise a crash when it sees one? ===');

// Real herdr INFO lines, taken verbatim from a live session log. These are
// what six days of a HEALTHY session look like, and none may register.
const quiet = [
  '2026-08-23T15:00:29.474625Z  INFO herdr::api::server: api server listening path=C:\\x\\herdr.sock',
  '2026-08-23T15:00:29.475612Z  INFO herdr::app: using pane scrollback configuration pane_scrollback_limit_bytes=10000000',
  '2026-08-26T00:19:44.539511Z  INFO herdr::server::headless: client disconnected client_id=10',
  '2026-08-29T12:32:19.300389Z  INFO herdr::server::headless: client connected client_id=12 cols=80 rows=24',
];
check('a clean log produces no crash lines', crashLines(quiet).length === 0,
  crashLines(quiet).join(' | '));

// The shapes the Linux run produced on 17 August, plus the usual rust aborts.
const bad = [
  '2026-08-17T09:12:03.1Z ERROR herdr::server: connection handler died',
  "thread 'main' panicked at src/pty.rs:214:9",
  'Process aborted (SIGABRT)',
  '2026-08-17T09:12:04.0Z FATAL unrecoverable state',
  'assertion failed: index < len',
];
for (const line of bad) {
  check('flags: ' + line.slice(0, 46), crashLines([line]).length === 1);
}
check('a mixed log reports only the bad lines',
  crashLines(quiet.concat(bad)).length === bad.length);

// A pattern that matched everything would also "pass" every test above, so
// assert it is actually selective.
check('the patterns are selective, not a catch-all',
  crashLines(['2026-08-29T12:00:00Z  INFO herdr::app: all is well']).length === 0);

// ─── every abort, with its own timestamp ─────────────────────────
console.log('\n=== does it record EVERY abort, with a timestamp? ===');

const TICK_T = '2026-09-01T12:00:00Z';
let ab = abortsFrom(bad, TICK_T);
check('one record per abort line, none dropped', ab.length === bad.length,
  ab.length + ' of ' + bad.length);
check('a stamped line keeps its OWN timestamp, not the tick time',
  ab[0].at === '2026-08-17T09:12:03.1Z' && ab[0].atSource === 'log',
  ab[0].at + ' (' + ab[0].atSource + ')');
check('an unstamped line falls back to the tick, and says so',
  ab[1].atSource === 'tick' && ab[1].at === TICK_T,
  ab[1].at + ' (' + ab[1].atSource + ')');

// The objective is "record every abort". A sample is not every abort, so a
// realistic burst must come back whole.
const burst = [];
for (let i = 0; i < 50; i++) burst.push('2026-08-17T09:' + String(i).padStart(2, '0') + ':00.0Z ERROR herdr: died');
check('a 50-abort burst is recorded whole, not sampled',
  abortsFrom(burst, TICK_T).length === 50, abortsFrom(burst, TICK_T).length + '');
check('and the per-tick cap is well clear of a realistic burst',
  MAX_ABORTS_PER_TICK >= 200, 'cap=' + MAX_ABORTS_PER_TICK);

// ─── incremental log reading ─────────────────────────────────────
console.log('\n=== does it read only what is new? ===');
const logFile = path.join(tmp, 'herdr-server.log');
fs.writeFileSync(logFile, quiet.join('\n') + '\n');
let s = scanLogTail(logFile, 0);
check('first read takes the whole file', s.lines.length === quiet.length, s.lines.length + ' lines');
const size1 = s.size;

s = scanLogTail(logFile, size1);
check('an unchanged log yields nothing', s.lines.length === 0 && s.state === 'unchanged');

fs.appendFileSync(logFile, bad[1] + '\n');
s = scanLogTail(logFile, size1);
check('only the appended line is read', s.lines.length === 1, JSON.stringify(s.lines[0]).slice(0, 60));
check('and it is recognised as a crash', crashLines(s.lines).length === 1);

// Rotation must not silently swallow events: if the file shrank, the bytes we
// were tracking are gone and the only safe move is to re-read from the top.
fs.writeFileSync(logFile, bad[0] + '\n');
s = scanLogTail(logFile, size1 + 200);
check('a rotated (shrunk) log is re-read from the top, not skipped',
  s.lines.length === 1 && crashLines(s.lines).length === 1);

// An absent log is not an empty one.
s = scanLogTail(path.join(tmp, 'nope.log'), 0);
check('an absent log reports absent, not clean', s.state === 'absent');

// ─── the summary refuses to overclaim ────────────────────────────
console.log('\n=== does the summary refuse to overclaim? ===');

function writeRecs(file, recs) {
  fs.writeFileSync(file, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function capture(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return out.join('\n');
}

const hour = 3600000;
const t0 = Date.parse('2026-09-01T00:00:00Z');
const iso = ms => new Date(ms).toISOString();

// A fully observed, quiet window.
const dense = [];
for (let i = 0; i < 25; i++) {
  dense.push({ t: iso(t0 + i * hour), tick: i + 1, verdict: 'ok', sinceLastMs: i ? hour : undefined });
}
const f1 = path.join(tmp, 'dense.jsonl');
writeRecs(f1, dense);
let text = capture(() => summarise(f1));
check('a fully observed quiet window reads as clean', /VERDICT: clean/.test(text));
check('and it still reports coverage rather than just a zero',
  /COVERAGE/.test(text) && /100%/.test(text), (text.match(/COVERAGE.*/) || [''])[0].trim());

// The 29 August situation: a long window with almost nothing observed. This
// MUST NOT read as clean -- that misreading is the reason this file exists.
const sparse = [
  { t: iso(t0), tick: 1, verdict: 'ok' },
  { t: iso(t0 + hour), tick: 2, verdict: 'ok', sinceLastMs: hour },
  { t: iso(t0 + 96 * hour), tick: 3, verdict: 'ok', sinceLastMs: 95 * hour, gap: true },
];
const f2 = path.join(tmp, 'sparse.jsonl');
writeRecs(f2, sparse);
text = capture(() => summarise(f2));
check('an unwatched window REFUSES to read as clean',
  /INSUFFICIENT COVERAGE/.test(text));
check('and it names the unwatched hours',
  /UNWATCHED/.test(text), (text.match(/COVERAGE.*/) || [''])[0].trim());

// A crash anywhere in the window dominates.
const withCrash = dense.slice(0, 10).concat([{
  t: iso(t0 + 10 * hour), tick: 11, verdict: 'crash', sinceLastMs: hour,
  crashes: [{ session: 'cmh-0', count: 3, aborts: [
    { at: iso(t0 + 10 * hour), atSource: 'log', line: "thread 'main' panicked" },
    { at: iso(t0 + 10 * hour), atSource: 'log', line: 'SIGABRT' },
    { at: iso(t0 + 10 * hour), atSource: 'log', line: 'fatal' },
  ] }],
}]);
const f3 = path.join(tmp, 'crash.jsonl');
writeRecs(f3, withCrash);
text = capture(() => summarise(f3));
check('a crash in the window dominates the verdict', /CRASHES OBSERVED/.test(text));
// Counting the ticks that carried aborts would say 1 where the truth is 3.
check('the summary counts ABORTS, not the ticks that carried them',
  /3 log abort\(s\)/.test(text), (text.match(/aborts .*/) || [''])[0].trim());

// When the cap does bite, the artifact must not claim to be complete.
const capped = [{
  t: iso(t0), tick: 1, verdict: 'crash',
  crashes: [{ session: 'cmh-0', count: 500, truncated: 300, aborts: [
    { at: iso(t0), atSource: 'log', line: 'SIGABRT' }] }],
}];
const f5 = path.join(tmp, 'capped.jsonl');
writeRecs(f5, capped);
text = capture(() => summarise(f5));
check('a truncated record says how many it could not store',
  /300 NOT STORED/.test(text), (text.match(/aborts .*/) || [''])[0].trim());

// An unknown tick is not a clean tick.
const withUnknown = dense.slice(0, 10).concat([
  { t: iso(t0 + 10 * hour), tick: 11, verdict: 'unknown', sinceLastMs: hour },
]);
const f4 = path.join(tmp, 'unknown.jsonl');
writeRecs(f4, withUnknown);
text = capture(() => summarise(f4));
check('an unknown tick is surfaced, not folded into clean',
  /could not ask herdr -- those are unknown, not clean/.test(text));

// No file at all is the loudest case: it is the state the project was in.
const missing = capture(() => summarise(path.join(tmp, 'does-not-exist.jsonl')));
check('no data says so, rather than reporting zero crashes',
  /NO WATCH DATA/.test(missing) && /NOT the same as/.test(missing));

// ─── state survives the watcher ──────────────────────────────────
console.log('\n=== does the watch survive its own restart? ===');

const stOut = path.join(tmp, 'state-test.jsonl');
let fresh = loadState(stOut);
check('with no prior state it starts clean, and knows it did',
  fresh.tick === 0 && fresh.resumed === false);

fresh.tick = 42;
fresh.lastTickAt = Date.now();
fresh.logs = { 'cmh-0': { size: 9784 } };
fresh.everRunning = { 'cmh-0': true };
saveState(stOut, fresh);

const resumed = loadState(stOut);
// Without this, a reboot mid-soak re-reads every log from byte 0 and reports
// the whole history as fresh aborts, while forgetting which sessions were
// alive -- so a death during the outage is never flagged. Both are silent.
check('a restart resumes the log offset rather than re-reading from zero',
  resumed.logs['cmh-0'].size === 9784, JSON.stringify(resumed.logs));
check('a restart remembers which sessions were running',
  resumed.everRunning['cmh-0'] === true);
check('and it reports that it resumed rather than pretending to be fresh',
  resumed.resumed === true && resumed.tick === 42, 'tick ' + resumed.tick);
check('the state file sits beside the record, not somewhere else',
  statePath(stOut) === stOut + '.state');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
