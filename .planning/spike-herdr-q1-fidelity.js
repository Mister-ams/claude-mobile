#!/usr/bin/env node
/**
 * spike-herdr-q1-fidelity.js -- Wave 1 / S1, QUESTION 1: stream fidelity.
 *
 * What does pane.read actually return -- raw pty bytes, styled runs, or a
 * cell grid? And does it survive the three things our server-side mirror
 * (server.js:1016-1198) exists to reconstruct: SGR colour, bold/italic/
 * reverse, and OSC-8 hyperlinks (the private-internals reach at :1099)?
 *
 * Method: paint a pane with a known-nasty line, then read it back through
 * every (source x format x strip_ansi) combination the API offers and
 * inspect the OUTPUT line -- deliberately excluding the echoed command,
 * which would otherwise show our own escape text back to us and read as a
 * false positive.
 *
 * Run INSIDE WSL:  node spike-herdr-q1-fidelity.js
 */
const { call } = require('./spike-herdr-client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const SGR_LINE =
  `printf '\\033[1mBOLD\\033[0m|\\033[3mITALIC\\033[0m|\\033[4mUNDER\\033[0m|` +
  `\\033[7mREVERSE\\033[0m|\\033[38;2;255;100;0mTRUECOLOR\\033[0m|` +
  `\\033[48;5;27mBG256\\033[0m|'`;
const OSC8_LINE = `printf '\\033]8;id=probe1;https://example.com/spike\\033\\\\LINKTEXT\\033]8;;\\033\\\\\\n'`;

/** the rendered output line, not the shell's echo of what we typed */
function outputLine(text) {
  return (
    text
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .find((l) => l.includes('BOLD') && !l.includes('printf')) || null
  );
}

async function main() {
  log('===== Q1: STREAM FIDELITY =====\n');

  const ws = await call('workspace.create', {
    label: 'spike-q1b',
    cwd: '/tmp/herdr-spike',
    focus: true,
  });
  const paneId = ws.root_pane.pane_id;
  log('pane=' + paneId);
  await sleep(900);

  // clear first so the echoed command scrolls off where possible
  await call('pane.send_text', { pane_id: paneId, text: 'clear\n' });
  await sleep(600);
  await call('pane.send_text', { pane_id: paneId, text: SGR_LINE + '; ' + OSC8_LINE + '\n' });
  await sleep(2000);

  const combos = [];
  for (const source of ['visible', 'recent', 'recent_unwrapped', 'detection']) {
    for (const format of ['text', 'ansi']) {
      for (const strip_ansi of [true, false]) {
        combos.push({ source, format, strip_ansi });
      }
    }
  }

  const summary = [];
  for (const c of combos) {
    let row;
    try {
      const res = await call('pane.read', { pane_id: paneId, ...c });
      const r = res.read || res;
      const line = outputLine(r.text || '');
      if (line === null) {
        row = { ...c, found: false };
      } else {
        row = {
          ...c,
          found: true,
          sgr: /\x1b\[/.test(line),
          bold: /\x1b\[[0-9;]*1m/.test(line),
          italic: /\x1b\[[0-9;]*3m/.test(line),
          underline: /\x1b\[[0-9;]*4m/.test(line),
          reverse: /\x1b\[[0-9;]*7m/.test(line),
          truecolor: line.includes('38;2;255;100;0'),
          bg256: line.includes('48;5;27'),
          osc8: /\x1b\]8/.test(line),
          url: line.includes('example.com'),
          linktext: line.includes('LINKTEXT'),
        };
        if (c.source === 'visible' && c.format === 'ansi' && c.strip_ansi === false) {
          log('\n--- CANONICAL SAMPLE (visible/ansi/strip_ansi=false) ---');
          log(JSON.stringify(line));
        }
      }
    } catch (e) {
      row = { ...c, error: e.message.slice(0, 60) };
    }
    summary.push(row);
  }

  log('\n===== MATRIX =====');
  log(
    ['source', 'format', 'strip', 'found', 'SGR', 'bold', 'ital', 'undl', 'rev', 'tc', 'bg256', 'OSC8', 'url']
      .map((h) => h.padEnd(7))
      .join('')
  );
  for (const r of summary) {
    const cell = (v) => (v === true ? 'YES' : v === false ? 'no' : '-').padEnd(7);
    log(
      String(r.source).padEnd(7) +
        String(r.format).padEnd(7) +
        String(r.strip_ansi).padEnd(7) +
        cell(r.found) +
        cell(r.sgr) +
        cell(r.bold) +
        cell(r.italic) +
        cell(r.underline) +
        cell(r.reverse) +
        cell(r.truecolor) +
        cell(r.bg256) +
        cell(r.osc8) +
        cell(r.url) +
        (r.error ? '  ERR:' + r.error : '')
    );
  }

  log('\n===== VERDICT INPUTS =====');
  const best = summary.find((r) => r.source === 'visible' && r.format === 'ansi' && !r.strip_ansi);
  log('SGR recoverable:        ' + (best && best.sgr));
  log('OSC-8 recoverable:      ' + (best && best.osc8));
  log('hyperlink URL survives: ' + (best && best.url));
}

main().catch((e) => {
  console.error('FATAL: ' + e.message);
  process.exit(1);
});
