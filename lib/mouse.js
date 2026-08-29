// ─── T22: mouse reporting ────────────────────────────────────────
//
// herdr is mouse-first. Measured off a live herdr client under node-pty, it
// requests CSI ?1003h (any-event tracking) and CSI ?1006h (SGR encoding) on
// startup -- so before this every tap in a herdr pane went nowhere, which is
// the recorded reason herdr felt bad on the iPad.
//
// The other modes are implemented because a session is not always herdr:
// dtach runs whatever the project's shell starts, and an app that asked for
// CSI ?1000h must not silently get nothing.
//
// This lives in lib/ rather than server.js so the encoding can be tested
// without booting a server, a pty, or a backend -- see
// test/t22-mouse-verify.js.

// DEC private modes that select how a mouse report is spelled. 1016 is
// SGR-pixel; we report cells, not pixels, so it is answered as plain SGR,
// which is the same grammar with cell coordinates.
const MOUSE_ENCODINGS = { 1005: 'utf8', 1006: 'sgr', 1015: 'urxvt', 1016: 'sgr' };
const MOUSE_BUTTONS = { left: 0, middle: 1, right: 2 };
const MOUSE_ACTIONS = ['down', 'up', 'move', 'wheel'];

// What the application has asked for, as one value.
//
// No headless mirror means the answer is "none". That is deliberately NOT the
// usual unknown-is-not-negative case: here the two genuinely cannot be told
// apart, and the safe direction is asymmetric. Sending mouse bytes to an app
// that never asked types visible garbage into the operator's shell;
// withholding them from an app that did costs one click.
function mouseState(session) {
  const term = session && session.headless;
  if (!term) return { tracking: 'none', encoding: 'default' };
  let tracking = 'none';
  try { tracking = term.modes.mouseTrackingMode || 'none'; }
  catch (e) { tracking = 'none'; }
  return { tracking, encoding: session.mouseEncoding || 'default' };
}

// Button byte, per xterm's spec: the low two bits pick the button, 32 marks a
// motion event, 64 marks a wheel, and modifiers are 4/8/16.
//
// Returns null when the mode the app chose does not carry this event at all.
// An x10 app is not listening for releases, and inventing one for it would be
// noise it cannot interpret.
function encodeMouse(ev, state) {
  const tracking = state.tracking;
  const encoding = state.encoding;
  if (tracking === 'none') return null;

  const isMotion = ev.action === 'move';
  const isWheel = ev.action === 'wheel';
  const isRelease = ev.action === 'up';

  if (tracking === 'x10' && (isMotion || isRelease || isWheel)) return null;
  if (tracking === 'vt200' && isMotion) return null;
  if (tracking === 'drag' && isMotion && ev.button === null) return null;

  let cb;
  if (isWheel) {
    cb = ev.delta < 0 ? 64 : 65;
  } else if (isMotion && ev.button === null) {
    cb = 3 + 32;                          // motion with no button held
  } else {
    cb = MOUSE_BUTTONS[ev.button] !== undefined ? MOUSE_BUTTONS[ev.button] : 0;
    if (isMotion) cb += 32;
  }

  // x10 predates modifier reporting; sending it 4/8/16 would be read as a
  // different button entirely.
  if (tracking !== 'x10') {
    if (ev.shift) cb += 4;
    if (ev.alt) cb += 8;
    if (ev.ctrl) cb += 16;
  }

  // SGR puts press-vs-release in the final byte, which is why it has no
  // column ceiling and why herdr asks for it.
  if (encoding === 'sgr') {
    return '\x1b[<' + cb + ';' + ev.col + ';' + ev.row + (isRelease ? 'm' : 'M');
  }
  if (encoding === 'urxvt') {
    return '\x1b[' + (32 + cb) + ';' + ev.col + ';' + ev.row + 'M';
  }

  // The two byte-oriented encodings cannot express a release as anything but
  // "button 3", and they cap the addressable grid: 223 cells for the classic
  // form, and where a 1005 client stops agreeing with us for utf8. Past the
  // cap the app cannot be told the truth, so it is told nothing rather than
  // the wrong cell.
  const cap = encoding === 'utf8' ? 2015 : 223;
  if (ev.col > cap || ev.row > cap) return null;
  const b = isRelease ? (3 + (cb & ~3)) : cb;
  return '\x1b[M' + String.fromCharCode(32 + b, 32 + ev.col, 32 + ev.row);
}

// Register the encoding capture on a session's headless mirror.
//
// xterm exposes the TRACKING mode via term.modes.mouseTrackingMode but says
// nothing about the ENCODING, and they are independent DEC modes. Both are
// needed: the mode decides which events the app wants to hear, the encoding
// decides how to spell them.
//
// Measured, and the detail matters: herdr emits the two as ONE combined
// sequence, `CSI ?1003;1006h`. A handler that matched a single parameter
// would capture nothing and leave the encoding at its default, which would
// then spell every report in the byte-oriented form to an app expecting SGR
// -- wrong cells past column 95, and nothing at all past 223.
function trackMouseModes(session) {
  session.mouseEncoding = 'default';
  for (const final of ['h', 'l']) {
    session.headless.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      for (const p of params) {
        const n = Array.isArray(p) ? p[0] : p;
        const enc = MOUSE_ENCODINGS[n];
        if (enc) session.mouseEncoding = (final === 'h') ? enc : 'default';
      }
      return false;  // let xterm apply the mode as usual
    });
  }
}

module.exports = {
  MOUSE_ENCODINGS, MOUSE_BUTTONS, MOUSE_ACTIONS,
  mouseState, encodeMouse, trackMouseModes,
};
