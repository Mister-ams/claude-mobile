#!/usr/bin/env node
/**
 * spike-herdr-fastwatch.js -- high-resolution agent-state sampler.
 *
 * The 1s sampler missed a 2s "working" window, so this samples every 200ms
 * and records every distinct (agent, status, title) tuple with timestamps.
 * Used for S1 question 2 (does herdr report idle/working/blocked/done).
 *
 * Usage INSIDE WSL:
 *   node spike-herdr-fastwatch.js <pane_id> <seconds> [interval_ms]
 */
const { call } = require('./spike-herdr-client.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pane = process.argv[2];
  const secs = Number(process.argv[3] || 60);
  const interval = Number(process.argv[4] || 200);
  const t0 = Date.now();
  const transitions = [];
  let last = '';
  let samples = 0;

  while (Date.now() - t0 < secs * 1000) {
    let s;
    try {
      const res = await call('pane.get', { pane_id: pane });
      s = res.pane || res;
    } catch (e) {
      await sleep(interval);
      continue;
    }
    samples++;
    const key = s.agent + '|' + s.agent_status + '|' + s.terminal_title_stripped;
    if (key !== last) {
      const dt = ((Date.now() - t0) / 1000).toFixed(2);
      transitions.push({ t: dt, agent: s.agent, status: s.agent_status, title: s.terminal_title_stripped });
      console.log(
        `t+${dt}s  status=${String(s.agent_status).padEnd(8)} agent=${s.agent} title=${JSON.stringify(s.terminal_title_stripped)}`
      );
      last = key;
    }
    await sleep(interval);
  }

  console.log('\nsamples=' + samples + '  distinct transitions=' + transitions.length);
  const statuses = [...new Set(transitions.map((t) => t.status))];
  console.log('statuses observed: ' + JSON.stringify(statuses));
}

main().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(1);
});
