#!/usr/bin/env node
/**
 * spike-herdr-explain.js -- capture agent.explain WHILE the agent is busy.
 *
 * herdr reported `idle` across a real 17s Claude task, so the question is
 * which detection rule was supposed to fire and what evidence it saw.
 * agent.explain returns the evaluated rule set with the actual screen
 * region each rule inspected -- that is the ground truth for S1 question 2.
 *
 * Usage INSIDE WSL:
 *   node spike-herdr-explain.js <pane_id> [samples] [interval_ms]
 */
const { call } = require('./spike-herdr-client.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pane = process.argv[2];
  const n = Number(process.argv[3] || 1);
  const interval = Number(process.argv[4] || 2000);

  for (let i = 0; i < n; i++) {
    const st = await call('pane.get', { pane_id: pane });
    const p = st.pane || st;
    const ex = await call('agent.explain', { target: pane });
    const e = ex.explain || ex;
    console.log('\n########## sample ' + i + '  status=' + p.agent_status + '  title=' + JSON.stringify(p.terminal_title_stripped) + ' ##########');
    console.log('agent=' + e.agent + '  keys=' + Object.keys(e).join(','));
    for (const r of e.evaluated_rules || []) {
      console.log(
        '  rule=' + String(r.id).padEnd(26) +
          ' state=' + String(r.state).padEnd(8) +
          ' matched=' + String(r.matched).padEnd(6) +
          ' prio=' + r.priority +
          ' region=' + r.region
      );
      const ev = r.evidence || {};
      const pats = []
        .concat(ev.contains || [], ev.regex || [], ev.line_regex || []);
      if (pats.length) console.log('      patterns: ' + JSON.stringify(pats));
      if (ev.region_preview) console.log('      saw: ' + JSON.stringify(String(ev.region_preview).slice(0, 220)));
    }
    // anything outside evaluated_rules?
    for (const k of Object.keys(e)) {
      if (k !== 'evaluated_rules') console.log('  ' + k + ' = ' + JSON.stringify(e[k]));
    }
    if (i < n - 1) await sleep(interval);
  }
}

main().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(1);
});
