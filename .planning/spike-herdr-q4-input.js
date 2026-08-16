#!/usr/bin/env node
/**
 * spike-herdr-q4-input.js -- Wave 1 / S1, QUESTION 4: input atomicity.
 *
 * claude-mobile has a documented race (CLAUDE.md:93): "Text and Enter must
 * be sent as single atomic pty write" -- separate writes race in the
 * pipeline. This probe establishes which herdr input method, if any,
 * delivers text+submit as ONE operation.
 *
 * Methods under test:
 *   A. pane.send_text  text + "\n"    (LF)
 *   B. pane.send_text  text + "\r"    (CR)
 *   C. pane.send_input {text, keys}   -- both fields in ONE request
 *   D. agent.prompt    {target, text} -- the agent-level submit
 *   E. pane.send_text then pane.send_keys -- the RACY 2-call baseline
 *
 * A long payload is used so a torn/partial write would be visible.
 *
 * Run INSIDE WSL:  node spike-herdr-q4-input.js <pane_id> <method A|B|C|D|E>
 */
const { call } = require('./spike-herdr-client.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARK = 'ATOMICITY_PROBE';
// long enough that a torn write would show up as a split line
const LONG = MARK + ' ' + 'x'.repeat(200) + ' END_OF_PROBE';

async function screen(pane, lines = 12) {
  const res = await call('pane.read', {
    pane_id: pane,
    source: 'visible',
    format: 'text',
    strip_ansi: true,
  });
  return ((res.read || res).text || '').split('\n').filter((l) => l.trim()).slice(-lines).join('\n');
}

async function main() {
  const pane = process.argv[2];
  const method = (process.argv[3] || 'C').toUpperCase();
  const text = process.argv[4] || LONG;

  console.log('=== method ' + method + ' on ' + pane + ' ===');
  console.log('payload length=' + text.length);

  const t0 = Date.now();
  let calls = 0;
  try {
    if (method === 'A') {
      await call('pane.send_text', { pane_id: pane, text: text + '\n' });
      calls = 1;
    } else if (method === 'B') {
      await call('pane.send_text', { pane_id: pane, text: text + '\r' });
      calls = 1;
    } else if (method === 'C') {
      await call('pane.send_input', { pane_id: pane, text, keys: ['enter'] });
      calls = 1;
    } else if (method === 'D') {
      await call('agent.prompt', { target: pane, text });
      calls = 1;
    } else if (method === 'E') {
      await call('pane.send_text', { pane_id: pane, text });
      await call('pane.send_keys', { pane_id: pane, keys: ['enter'] });
      calls = 2;
    } else {
      throw new Error('unknown method');
    }
    console.log('OK  socket round-trips=' + calls + '  elapsed=' + (Date.now() - t0) + 'ms');
  } catch (e) {
    console.log('ERROR: ' + e.message);
  }

  await sleep(2500);
  console.log('--- screen ---');
  console.log(await screen(pane, 14));
}

main().catch((e) => {
  console.error('FATAL ' + e.message);
  process.exit(1);
});
