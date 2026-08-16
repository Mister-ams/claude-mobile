#!/usr/bin/env node
/**
 * spike-herdr-q2-agentstate.js -- Wave 1 / S1, QUESTION 2 (decides D2).
 *
 * Launches Claude in a herdr pane under a chosen launch mode and watches
 * whether herdr (a) detects an agent at all and (b) reports state
 * transitions (idle / working / blocked / done).
 *
 * Hypothesis under test: the Windows-interop process tree
 * (`cmd.exe /c claude`) defeats herdr's foreground-process detection and
 * breaks session-resume identity, while a native WSL `claude` is detected.
 *
 * Usage INSIDE WSL:
 *   node spike-herdr-q2-agentstate.js native
 *   node spike-herdr-q2-agentstate.js interop
 *   node spike-herdr-q2-agentstate.js native "2+2, reply with just the number"
 */
const { call } = require('./spike-herdr-client.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const MODES = {
  native: { cmd: 'claude', label: 'native WSL claude' },
  interop: { cmd: 'cmd.exe /c claude', label: 'Windows interop cmd.exe /c claude' },
};

async function poll(paneId, seconds, tag) {
  const seen = [];
  for (let i = 0; i < seconds; i++) {
    const res = await call('pane.get', { pane_id: paneId });
    const p = res.pane || res;
    const key = [p.agent, p.agent_status, p.display_agent, p.terminal_title_stripped].join('|');
    if (!seen.length || seen[seen.length - 1].key !== key) {
      seen.push({ t: i, key, agent: p.agent, status: p.agent_status, title: p.terminal_title_stripped });
      log(
        `  [${tag} t+${i}s] agent=${JSON.stringify(p.agent)} status=${p.agent_status}` +
          ` display=${JSON.stringify(p.display_agent)} title=${JSON.stringify(p.terminal_title_stripped)}`
      );
    }
    await sleep(1000);
  }
  return seen;
}

async function main() {
  const mode = process.argv[2] || 'native';
  const prompt = process.argv[3] || null;
  const m = MODES[mode];
  if (!m) throw new Error('mode must be native|interop');

  log('===== Q2: AGENT STATE -- ' + m.label + ' =====\n');

  const ws = await call('workspace.create', {
    label: 'spike-q2-' + mode,
    cwd: '/tmp/herdr-spike',
    focus: true,
  });
  const paneId = ws.root_pane.pane_id;
  log('pane=' + paneId + '  launching: ' + m.cmd + '\n');
  await sleep(1000);

  await call('pane.send_text', { pane_id: paneId, text: m.cmd + '\n' });

  log('-- polling agent detection for 30s --');
  await poll(paneId, 30, 'launch');

  log('\n-- process tree herdr sees (pane.process_info) --');
  try {
    log(JSON.stringify(await call('pane.process_info', { pane_id: paneId }), null, 1));
  } catch (e) {
    log('ERROR: ' + e.message);
  }

  log('\n-- agent.list --');
  try {
    log(JSON.stringify(await call('agent.list', {}), null, 1));
  } catch (e) {
    log('ERROR: ' + e.message);
  }

  log('\n-- agent.explain (why detected / not) --');
  for (const target of [paneId, ws.workspace.workspace_id]) {
    try {
      log('target=' + target + ': ' + JSON.stringify(await call('agent.explain', { target }), null, 1));
      break;
    } catch (e) {
      log('  target=' + target + ' ERROR: ' + e.message);
    }
  }

  if (prompt) {
    log('\n-- sending prompt, watching for working/blocked/done --');
    await call('pane.send_text', { pane_id: paneId, text: prompt + '\n' });
    await poll(paneId, 45, 'prompt');
  }

  log('\n-- final screen (last 25 lines) --');
  const r = await call('pane.read', {
    pane_id: paneId,
    source: 'visible',
    format: 'text',
    strip_ansi: true,
  });
  const body = r.read || r;
  log(
    (body.text || '')
      .split('\n')
      .slice(-25)
      .join('\n')
  );

  log('\npane kept alive for follow-up: ' + paneId);
}

main().catch((e) => {
  console.error('FATAL: ' + e.message);
  process.exit(1);
});
