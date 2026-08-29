#!/usr/bin/env node
// T22 verification -- three parts, and the last is the one that matters.
//
// A   a table of byte sequences for lib/mouse.js. Cheap, catches an encoding
//     regression, but on its own only confirms our belief about the grammar.
// A.5 the DEC mode capture, against the exact bytes a live herdr client
//     sends. This is where a plausible-looking handler silently fails.
// B   drives a REAL herdr session through a real pty and asserts a click
//     MOVES FOCUS between two panes. That is the artifact this task exists to
//     fix: before T22 every click in a pane was inert. A control case runs
//     first -- focus must NOT move on its own -- so a pass cannot be an
//     accident of herdr focusing something for its own reasons.
//
//   node test/t22-mouse-verify.js            # all three
//   node test/t22-mouse-verify.js --unit     # A and A.5, no herdr needed
//
// Part B needs herdr on PATH (or HERDR_BIN) and node-pty resolvable.

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const { encodeMouse, mouseState, trackMouseModes } = require('../lib/mouse');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
const show = s => s === null ? 'null' : JSON.stringify(s).slice(1, -1);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── PART A: the encoding table ──────────────────────────────────
console.log('\n=== PART A: encodeMouse byte sequences ===');

const SGR = { tracking: 'any', encoding: 'sgr' };
const ev = (o) => Object.assign(
  { action: 'down', button: 'left', col: 10, row: 5, delta: 0,
    shift: false, alt: false, ctrl: false }, o);

const table = [
  ['left press, SGR',              ev({}),                                   SGR, '\x1b[<0;10;5M'],
  ['left release, SGR',            ev({ action: 'up' }),                     SGR, '\x1b[<0;10;5m'],
  ['motion, no button, any',       ev({ action: 'move', button: null }),     SGR, '\x1b[<35;10;5M'],
  ['motion, button held, drag',    ev({ action: 'move' }), { tracking: 'drag', encoding: 'sgr' }, '\x1b[<32;10;5M'],
  ['wheel up',                     ev({ action: 'wheel', button: null, delta: -1 }), SGR, '\x1b[<64;10;5M'],
  ['wheel down',                   ev({ action: 'wheel', button: null, delta: 1 }),  SGR, '\x1b[<65;10;5M'],
  ['right press + ctrl',           ev({ button: 'right', ctrl: true }),      SGR, '\x1b[<18;10;5M'],
  ['left press + shift',           ev({ shift: true }),                      SGR, '\x1b[<4;10;5M'],
  ['middle press',                 ev({ button: 'middle' }),                 SGR, '\x1b[<1;10;5M'],
  ['urxvt press',                  ev({}), { tracking: 'any', encoding: 'urxvt' },   '\x1b[32;10;5M'],
  ['x10 press, byte encoding',     ev({}), { tracking: 'x10', encoding: 'default' }, '\x1b[M *%'],
  ['byte-encoded release is btn 3', ev({ action: 'up' }), { tracking: 'any', encoding: 'default' }, '\x1b[M#*%'],
];
for (const [name, e, st, want] of table) {
  const got = encodeMouse(e, st);
  check(name, got === want, got === want ? show(want) : 'want ' + show(want) + ' got ' + show(got));
}

// Refusals. Each is a mode that cannot carry the event; silence is the
// correct answer and a wrong byte would be worse than none.
const refusals = [
  ['tracking none says nothing',   ev({}),                               { tracking: 'none', encoding: 'sgr' }],
  ['x10 has no release',           ev({ action: 'up' }),                 { tracking: 'x10', encoding: 'default' }],
  ['x10 has no motion',            ev({ action: 'move' }),               { tracking: 'x10', encoding: 'default' }],
  ['x10 has no wheel',             ev({ action: 'wheel', button: null, delta: -1 }), { tracking: 'x10', encoding: 'default' }],
  ['vt200 has no motion',          ev({ action: 'move' }),               { tracking: 'vt200', encoding: 'sgr' }],
  ['drag ignores hover motion',    ev({ action: 'move', button: null }), { tracking: 'drag', encoding: 'sgr' }],
  ['byte encoding caps at 223',    ev({ col: 224 }),                     { tracking: 'any', encoding: 'default' }],
];
for (const [name, e, st] of refusals) {
  const got = encodeMouse(e, st);
  check(name, got === null, got === null ? '' : 'expected null, got ' + show(got));
}

check('byte encoding still emits at 223',
  encodeMouse(ev({ col: 223 }), { tracking: 'any', encoding: 'default' }) !== null);
check('SGR has no column ceiling',
  encodeMouse(ev({ col: 500 }), SGR) === '\x1b[<0;500;5M');

// Every DEC private mode we claim to understand must round-trip through the
// encoder, or the table above is testing a subset of what ships.
for (const code of Object.keys(require('../lib/mouse').MOUSE_ENCODINGS)) {
  const enc = require('../lib/mouse').MOUSE_ENCODINGS[code];
  check('encoding ' + enc + ' (mode ' + code + ') produces bytes',
    typeof encodeMouse(ev({}), { tracking: 'any', encoding: enc }) === 'string');
}

// ─── the herdr session used by part B ────────────────────────────
const BIN = process.env.HERDR_BIN ||
  path.join(os.homedir(), 'tools', 'herdr', 'herdr.exe');
const SESSION = 'cmt22probe';
const CONFIG = path.join(__dirname, '..', 'herdr-config.toml');
const herdrEnv = () => Object.assign({}, process.env,
  { HERDR_SESSION: SESSION, HERDR_CONFIG_PATH: CONFIG });

function cli(args) {
  return execFileSync(BIN, args, {
    encoding: 'utf8', timeout: 20000, windowsHide: true, env: herdrEnv(),
  }).trim();
}
function snapshot() {
  return JSON.parse(cli(['api', 'snapshot'])).result.snapshot;
}
function cleanup() {
  for (const a of [['session', 'stop', SESSION], ['session', 'delete', SESSION]]) {
    try {
      execFileSync(BIN, a, { timeout: 20000, windowsHide: true, env: herdrEnv(), stdio: 'ignore' });
    } catch (e) { /* not running, or nothing to delete */ }
  }
}

// Every DEC private mode in a capture, expanded. herdr combines them
// (`CSI ?1003;1006h`), so a literal match for one of them finds nothing --
// which is exactly the bug this parser exists to avoid.
function decModes(text) {
  const seen = new Set();
  for (const m of text.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    for (const n of m[1].split(';')) seen.add(n + m[2]);
  }
  return seen;
}

(async () => {
  // ─── PART A.5: DEC mode capture ────────────────────────────────
  console.log('\n=== PART A.5: DEC mode capture, real xterm parser ===');
  let Headless = null;
  try { Headless = require('@xterm/headless').Terminal; } catch (e) { /* absent */ }

  if (!Headless) {
    console.log('  SKIP  @xterm/headless not resolvable here');
  } else {
    const session = { headless: new Headless({ cols: 120, rows: 40, allowProposedApi: true }) };
    trackMouseModes(session);
    const write = (d) => new Promise(r => session.headless.write(d, r));

    let st = mouseState(session);
    check('a fresh session requests nothing',
      st.tracking === 'none' && st.encoding === 'default',
      st.tracking + '/' + st.encoding);

    // The exact bytes captured off a live herdr client -- combined, not two
    // separate sequences. This is the case a naive handler gets wrong.
    await write('\x1b[?1003;1006h');
    st = mouseState(session);
    check('combined CSI ?1003;1006h sets tracking', st.tracking === 'any', st.tracking);
    check('combined CSI ?1003;1006h sets encoding', st.encoding === 'sgr', st.encoding);

    // ...and it has to come back off again, or a pane that leaves a
    // full-screen app would keep swallowing taps forever.
    await write('\x1b[?1003;1006l');
    st = mouseState(session);
    check('reset turns tracking back off', st.tracking === 'none', st.tracking);
    check('reset turns encoding back to default', st.encoding === 'default', st.encoding);

    // Separate sequences must work too -- not every app combines them.
    await write('\x1b[?1000h');
    await write('\x1b[?1006h');
    st = mouseState(session);
    check('separate sequences also captured',
      st.tracking === 'vt200' && st.encoding === 'sgr',
      st.tracking + '/' + st.encoding);
  }

  if (process.argv.includes('--unit')) {
    console.log('\n' + pass + ' passed, ' + fail + ' failed (no herdr)');
    process.exit(fail ? 1 : 0);
  }

  // ─── PART B: a click moves focus in a live herdr session ───────
  console.log('\n=== PART B: a real click in a real pane ===');

  let pty;
  try { pty = require('node-pty'); }
  catch (e) {
    console.log('  SKIP  node-pty not resolvable here -- run from an installed tree');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }

  cleanup();  // a stopped-but-not-deleted record would block the name
  const proc = pty.spawn(BIN, ['--session', SESSION], {
    name: 'xterm-256color', cols: 120, rows: 40,
    cwd: process.cwd(), env: herdrEnv(),
  });
  let out = '';
  proc.onData(d => { out += d; });

  try {
    // 1. herdr must actually ask for mouse, or nothing below means anything.
    for (let i = 0; i < 60 && !decModes(out).has('1003h'); i++) await sleep(250);
    const modes = decModes(out);
    check('herdr requested any-event tracking (?1003h)', modes.has('1003h'),
      [...modes].join(' '));
    check('herdr requested SGR encoding (?1006h)', modes.has('1006h'));

    // 2. Two panes, so focus has somewhere to move.
    cli(['pane', 'split', 'w1:p1', '--direction', 'right']);
    await sleep(1200);
    const layout = (snapshot().layouts || [])[0];
    if (!layout || layout.panes.length < 2) {
      check('split produced a second pane', false,
        'got ' + (layout ? layout.panes.length : 0));
      throw new Error('cannot test focus without two panes');
    }
    check('split produced a second pane', true, layout.panes.length + ' panes');

    const before = snapshot().focused_pane_id;
    const target = layout.panes.find(p => p.pane_id !== before);
    check('found an unfocused pane to click', !!target, target && target.pane_id);

    // 3. CONTROL: focus must not wander on its own. Without this, a pass
    //    below could just be herdr focusing something for its own reasons.
    await sleep(1500);
    check('control: focus does not move on its own',
      snapshot().focused_pane_id === before);

    // 4. Click the middle of the other pane. Cells are 1-based.
    const r = target.rect;
    const col = r.x + Math.floor(r.width / 2) + 1;
    const row = r.y + Math.floor(r.height / 2) + 1;
    const st = { tracking: 'any', encoding: 'sgr' };
    const base = { button: 'left', col, row, delta: 0, shift: false, alt: false, ctrl: false };
    const press = encodeMouse(Object.assign({ action: 'down' }, base), st);
    const release = encodeMouse(Object.assign({ action: 'up' }, base), st);
    console.log('  ..    clicking ' + target.pane_id + ' at cell ' + col + ',' + row +
                ' with ' + show(press));
    proc.write(press);
    await sleep(120);
    proc.write(release);

    // 5. The assertion this whole task exists for.
    let moved = false, after = before;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      after = snapshot().focused_pane_id;
      if (after !== before) { moved = true; break; }
    }
    check('THE CLICK LANDED -- focus moved ' + before + ' -> ' + after, moved,
      moved ? '' : 'focus never left ' + before);
    check('focus moved to the pane we clicked', after === target.pane_id,
      'wanted ' + (target && target.pane_id) + ', got ' + after);
  } catch (e) {
    check('part B ran to completion', false, e.message);
  } finally {
    // Do NOT proc.kill() -- node-pty's ConPTY teardown throws
    // "AttachConsole failed" on this box (P0.4). Retire the session through
    // herdr instead and let the process go with us.
    cleanup();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
