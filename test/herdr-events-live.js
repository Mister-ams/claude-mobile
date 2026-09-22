#!/usr/bin/env node
// Live check (T06, D7): the REAL lib/herdr-events.js feed, against a REAL
// herdr 0.8.2 server, survives that server being stopped and started again.
//
//   node test/herdr-events-live.js --session cmsim-90 [--prefix cmsim]
//        [--cwd DIR] [--config herdr-config.toml] [--start-claude]
//
// It owns its own throwaway herdr session rather than restarting the one a
// claude-mobile server is attached to, and that is deliberate, not a shortcut:
// on herdr 0.8.2 / Windows a server stop kills the pane processes (no live
// handoff -- `ping` reports live_handoff:false), the attached pty client exits,
// and claude-mobile's onExit -> backend.state() then reads the stopped record
// as 'stale' and DELETES it (heal-on-read in lib/session-backend/herdr.js).
// Restarting a claude-mobile session's herdr therefore races that delete and
// loses the session whatever the feed does -- measured 2026-09-22, audit line
// "Stopped herdr session removed: cmsim-0". That is session lifecycle, not the
// feed, and is reported separately.
//
// Refuses anything that is not <prefix>-N, refuses cm-N (the live sessions),
// refuses a session that already exists, and always stops + deletes the
// session it created. Prints one JSON line with the evidence; exit 0 = pass.
'use strict';
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { orphanSpawn } = require('../lib/orphan-spawn');
const { createAgentFeed } = require('../lib/herdr-events');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PREFIX = opt('--prefix', 'cmsim');
const NAME = opt('--session', `${PREFIX}-90`);
const CWD = opt('--cwd', os.tmpdir());
const CONFIG = path.resolve(opt('--config', path.join(__dirname, '..', 'herdr-config.toml')));
const START_CLAUDE = argv.includes('--start-claude');
const HERDR = process.env.HERDR_BIN || path.join(os.homedir(), 'tools', 'herdr', 'herdr.exe');

if (!new RegExp(`^${PREFIX}-\\d+$`).test(NAME) || /^cm-\d+$/.test(NAME) || PREFIX === 'cm') {
  console.log(JSON.stringify({ ok: false, error: `refusing session ${NAME}` }));
  process.exit(2);
}

function env(session) {
  const e = { ...process.env, HERDR_CONFIG_PATH: CONFIG };
  delete e.HERDR_SESSION; delete e.HERDR_PANE_ID;
  if (session) e.HERDR_SESSION = session;
  return e;
}
const cli = (args, session) => execFileSync(HERDR, args,
  { encoding: 'utf8', timeout: 25000, windowsHide: true, env: env(session) }).trim();
const record = () => JSON.parse(cli(['session', 'list', '--json'])).sessions.find(s => s.name === NAME) || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(100); }
  return !!(await pred());
}
const launch = () => orphanSpawn({ command: HERDR, args: ['server'], cwd: CWD, env: env(NAME) });

(async () => {
  const ev = { session: NAME };
  let feed = null;
  let created = false;
  let views = [];
  try {
    if (record()) throw new Error(`${NAME} already exists -- refusing to touch it`);
    launch();
    created = true;
    if (!await until(() => (record() || {}).running === true, 15000)) throw new Error('server never came up');
    cli(['workspace', 'create', '--cwd', CWD, '--label', NAME], NAME);
    const socketPath = record().socket_path;

    feed = createAgentFeed({
      socketPath, label: NAME,
      audit: (k, m) => { (ev.audit = ev.audit || []).push(`${k} ${m}`); },
      onChange: v => views.push({ t: Date.now(), feed: v.feed, status: v.status, agent: v.agent, reconnects: v.reconnects }),
    });
    feed.start();
    if (!await until(() => feed.view().feed === 'events', 10000)) throw new Error('feed never subscribed');
    ev.before = feed.view().feed;

    // Restart herdr under the feed.
    cli(['session', 'stop', NAME, '--json']);
    const tStop = Date.now();
    await until(() => feed.view().feed !== 'events', 5000);
    ev.duringRestart = { feed: feed.view().feed, status: feed.view().status };
    launch();
    await until(() => (record() || {}).running === true, 15000);
    const tUp = Date.now();
    const resumed = await until(() => feed.view().feed === 'events' && feed.view().reconnects >= 1, 15000);
    ev.resumed = resumed;
    ev.serverDownMs = tUp - tStop;
    ev.resumeAfterServerUpMs = resumed ? (views.find(v => v.t >= tUp && v.feed === 'events') || { t: Date.now() }).t - tUp : null;
    ev.reconnects = feed.view().reconnects;

    // A real agent event on the NEW subscription.
    if (resumed && START_CLAUDE) {
      const panes = JSON.parse(cli(['pane', 'list'], NAME)).result.panes || [];
      const pane = panes[0] && panes[0].pane_id;
      const t0 = Date.now();
      cli(['pane', 'run', pane, 'claude'], NAME);
      ev.agentAfterRestart = await until(() => feed.view().agent === 'claude' && feed.view().feed === 'events', 60000);
      ev.agentDetectMs = Date.now() - t0;
      ev.agentView = { agent: feed.view().agent, status: feed.view().status, feed: feed.view().feed };
    }
    ev.ok = !!resumed && ev.duringRestart.feed !== 'events' && (!START_CLAUDE || !!ev.agentAfterRestart);
  } catch (e) {
    ev.ok = false;
    ev.error = e.message;
  } finally {
    if (feed) feed.stop();
    if (created) {
      try { cli(['session', 'stop', NAME, '--json']); } catch (e) { /* may already be stopped */ }
      await until(() => !(record() || {}).running, 15000);
      try { cli(['session', 'delete', NAME, '--json']); } catch (e) { ev.cleanupError = e.message.split('\n')[0]; }
      ev.leftover = !!record();
      if (ev.leftover) ev.ok = false;
    }
    ev.transitions = views.map(v => `${v.feed}/${v.status}${v.agent ? '/' + v.agent : ''}`)
      .filter((s, i, a) => i === 0 || s !== a[i - 1]);
    console.log(JSON.stringify(ev));
    process.exit(ev.ok ? 0 : 1);
  }
})();
