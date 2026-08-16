#!/usr/bin/env node
/**
 * spike-herdr-step.js -- small interactive driver used across S1 questions.
 *
 * Lets the spike drive a pane one step at a time and observe the result,
 * rather than guessing a fixed script up front.
 *
 * Usage INSIDE WSL:
 *   node spike-herdr-step.js read   <pane>            # screen + agent state
 *   node spike-herdr-step.js text   <pane> "<text>"   # pane.send_text verbatim
 *   node spike-herdr-step.js keys   <pane> enter      # pane.send_keys
 *   node spike-herdr-step.js watch  <pane> <seconds>  # log state transitions
 *   node spike-herdr-step.js state  <pane>            # one-line agent state
 */
const { call } = require('./spike-herdr-client.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function screen(pane, lines = 30) {
  const res = await call('pane.read', {
    pane_id: pane,
    source: 'visible',
    format: 'text',
    strip_ansi: true,
  });
  const t = (res.read || res).text || '';
  return t.split('\n').filter((l) => l.trim()).slice(-lines).join('\n');
}

async function state(pane) {
  const res = await call('pane.get', { pane_id: pane });
  const p = res.pane || res;
  return {
    agent: p.agent,
    status: p.agent_status,
    title: p.terminal_title_stripped,
    cwd: p.foreground_cwd,
    revision: p.revision,
    agent_session: p.agent_session,
  };
}

async function main() {
  const [, , cmd, pane, arg] = process.argv;
  if (cmd === 'read') {
    console.log(JSON.stringify(await state(pane)));
    console.log('--- screen ---');
    console.log(await screen(pane, arg ? Number(arg) : 30));
  } else if (cmd === 'text') {
    await call('pane.send_text', { pane_id: pane, text: arg });
    console.log('sent text: ' + JSON.stringify(arg));
  } else if (cmd === 'keys') {
    await call('pane.send_keys', { pane_id: pane, keys: arg.split(',') });
    console.log('sent keys: ' + arg);
  } else if (cmd === 'state') {
    console.log(JSON.stringify(await state(pane)));
  } else if (cmd === 'watch') {
    const secs = Number(arg || 30);
    let last = '';
    for (let i = 0; i < secs; i++) {
      const s = await state(pane);
      const k = s.agent + '|' + s.status;
      if (k !== last) {
        console.log(`t+${i}s  agent=${s.agent} status=${s.status} title=${JSON.stringify(s.title)}`);
        last = k;
      }
      await sleep(1000);
    }
    console.log('final: ' + JSON.stringify(await state(pane)));
  } else {
    console.error('unknown command');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(1);
});
