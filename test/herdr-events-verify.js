#!/usr/bin/env node
// Verification for lib/herdr-events.js (T06, D7) against a FAKE herdr: a
// named-pipe server (a unix socket off Windows) that speaks the 0.8.2 wire
// shape measured on this machine -- one request per connection, except
// events.subscribe, which answers subscription_started and then streams.
//
// No real herdr, no deps. Each claim is also watched failing where that is
// meaningful (a dropped pipe, a dead server, a rejected subscribe).
//
//   node test/herdr-events-verify.js      (npm run test:herdr-events)

'use strict';
const net = require('net');
const os = require('os');
const path = require('path');
const { createAgentFeed, normaliseSnapshot, primaryAgent, pipePathFor } = require('../lib/herdr-events');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}

// -- a snapshot shaped like herdr 0.8.2's session.snapshot -----------
function agentInfo(pane, status, extra = {}) {
  return {
    agent: 'claude', agent_status: status, cwd: 'C:\\work', focused: pane === 'w1:p1',
    pane_id: pane, revision: 1, state_change_seq: 3, tab_id: 'w1:t1', terminal_id: 't',
    terminal_title: '* Claude Code', terminal_title_stripped: 'Claude Code', workspace_id: 'w1',
    agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'sess-1' },
    ...extra,
  };
}
function makeSnapshot(state) {
  return {
    version: '0.8.2', protocol: 20,
    workspaces: [{
      workspace_id: 'w1', label: 'cmsim-0', agent_status: 'idle', focused: true,
      number: 1, pane_count: state.panes.length, tab_count: 1, active_tab_id: 'w1:t1',
      worktree: state.worktree || null,
    }],
    tabs: [],
    panes: state.panes.map(p => ({ pane_id: p, workspace_id: 'w1', tab_id: 'w1:t1', cwd: 'C:\\work',
      focused: p === 'w1:p1', agent_status: 'unknown', revision: 1, terminal_id: 't' })),
    layouts: [],
    agents: state.agents,
  };
}

// -- the fake herdr ---------------------------------------------------
function fakeHerdr(pipe) {
  const f = {
    state: { panes: ['w1:p1'], agents: [agentInfo('w1:p1', 'blocked')] },
    subs: [],               // live subscription sockets
    subscribeRequests: [],  // params of every subscribe
    snapshotCount: 0,
    rejectSubscribe: false,
    snapshotDelayMs: 0,
    onSnapshot: null,       // hook: called when a snapshot request arrives
    server: null,
  };
  f.listen = () => new Promise((resolve, reject) => {
    f.server = net.createServer(sock => {
      let buf = '';
      sock.on('error', () => {});
      sock.on('data', async d => {
        buf += d.toString();
        const i = buf.indexOf('\n');
        if (i < 0) return;
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (req.method === 'session.snapshot') {
          f.snapshotCount++;
          if (f.onSnapshot) f.onSnapshot(f.snapshotCount);
          // Captured NOW, answered after the delay: a slow snapshot is a stale one.
          const reply = JSON.stringify({ id: req.id, result: { type: 'session_snapshot', snapshot: makeSnapshot(f.state) } });
          if (f.snapshotDelayMs) await sleep(f.snapshotDelayMs);
          sock.end(reply + '\n');
        } else if (req.method === 'events.subscribe') {
          f.subscribeRequests.push(req.params);
          if (f.rejectSubscribe) {
            sock.end(JSON.stringify({ id: req.id, error: { code: 'unsupported', message: 'no events here' } }) + '\n');
            return;
          }
          sock.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n');
          f.subs.push(sock);
          sock.on('close', () => { f.subs = f.subs.filter(s => s !== sock); });
        } else {
          sock.end(JSON.stringify({ id: req.id, error: { code: 'unknown_method', message: req.method } }) + '\n');
        }
      });
    });
    f.server.on('error', reject);
    f.server.listen(pipe, resolve);
  });
  f.push = (event, data) => {
    for (const s of f.subs) s.write(JSON.stringify({ event, data }) + '\n');
  };
  f.status = (pane, status) => {
    const a = f.state.agents.find(x => x.pane_id === pane);
    if (a) { a.agent_status = status; a.state_change_seq++; }
    f.push('pane.agent_status_changed', { agent: 'claude', agent_status: status, pane_id: pane, workspace_id: 'w1' });
  };
  f.dropSubs = () => { for (const s of f.subs) s.destroy(); f.subs = []; };
  f.close = () => new Promise(r => { f.dropSubs(); f.server.close(() => r()); });
  return f;
}

let pipeN = 0;
function pipeName() {
  const tag = `cm-herdr-events-test-${process.pid}-${++pipeN}`;
  return process.platform === 'win32' ? '\\\\.\\pipe\\' + tag : path.join(os.tmpdir(), tag + '.sock');
}

function feedFor(pipe, extra = {}) {
  const views = [];
  const audits = [];
  const feed = createAgentFeed({
    socketPath: pipe, label: 'cmsim-test',
    audit: (k, m) => audits.push(`${k} ${m}`),
    onChange: v => views.push({ t: Date.now(), ...v }),
    pollMs: 100, backoffMinMs: 50, backoffMaxMs: 200, requestTimeoutMs: 1000,
    ...extra,
  });
  return { feed, views, audits, last: () => views[views.length - 1] };
}

(async () => {
  // --- pure normalisation ------------------------------------------
  console.log('\n=== normalisation ===');
  const snap = makeSnapshot({
    panes: ['w1:p1', 'w1:p2'],
    agents: [agentInfo('w1:p1', 'idle', { foreground_cwd: 'C:\\work\\sub' }), agentInfo('w1:p2', 'blocked', { focused: false })],
    worktree: { repo_key: 'k', repo_name: 'claude-mobile', repo_root: 'C:\\repo', checkout_path: 'C:\\wt\\x', is_linked_worktree: true },
  });
  const n = normaliseSnapshot(snap);
  const a1 = n.agents.get('w1:p1');
  check('foreground_cwd wins over cwd', a1.cwd === 'C:\\work\\sub', a1.cwd);
  check('title is the stripped title', a1.title === 'Claude Code', a1.title);
  check('agent session id carried', a1.agentSessionId === 'sess-1');
  check('state_change_seq carried', a1.seq === 3);
  check('worktree normalised', JSON.stringify(n.worktrees.get('w1')) ===
    JSON.stringify({ repo: 'claude-mobile', root: 'C:\\repo', path: 'C:\\wt\\x', linked: true }));
  check('pane set sorted', n.panes.join(',') === 'w1:p1,w1:p2');
  check('a blocked pane speaks for the session over a focused idle one', primaryAgent(n.agents).paneId === 'w1:p2');
  check('an unrecognised status reads unknown, not a real state',
    normaliseSnapshot(makeSnapshot({ panes: ['w1:p1'], agents: [agentInfo('w1:p1', 'sleeping')] })).agents.get('w1:p1').status === 'unknown');
  let threw = false;
  try { normaliseSnapshot({ panes: [] }); } catch (e) { threw = true; }
  check('a snapshot with no agents array is an error, not "no agents"', threw);
  check('win32 pipe path is \\\\.\\pipe\\ + socket_path',
    pipePathFor('C:\\a\\herdr.sock', 'win32') === '\\\\.\\pipe\\C:\\a\\herdr.sock');

  // --- subscribe -> snapshot -> live events ------------------------
  console.log('\n=== live events ===');
  let pipe = pipeName();
  let fh = fakeHerdr(pipe);
  await fh.listen();
  let t = feedFor(pipe);
  t.feed.start();
  await until(() => t.last() && t.last().feed === 'events');
  check('bootstraps to feed=events with the snapshot status', t.last().feed === 'events' && t.last().status === 'blocked',
    JSON.stringify({ feed: t.last().feed, status: t.last().status }));
  check('subscribed to agent_status_changed for the known pane',
    fh.subscribeRequests[0].subscriptions.some(s => s.type === 'pane.agent_status_changed' && s.pane_id === 'w1:p1'));
  check('view carries cwd, title, agent, worktree fields',
    t.last().cwd === 'C:\\work' && t.last().title === 'Claude Code' && t.last().agent === 'claude' && 'worktree' in t.last());

  let t0 = Date.now();
  fh.status('w1:p1', 'working');
  await until(() => t.last().status === 'working');
  check('a status event reaches onChange', t.last().status === 'working', `${t.last().t - t0}ms`);
  fh.status('w1:p1', 'idle');
  await until(() => t.last().herdrStatus === 'idle');
  check('a finish nobody has seen reads done', t.last().status === 'done' && t.last().seen === false,
    JSON.stringify({ status: t.last().status, herdr: t.last().herdrStatus }));
  t.feed.markSeen();
  check('markSeen turns done into idle', t.last().status === 'idle' && t.last().seen === true);
  fh.status('w1:p1', 'working');
  await until(() => t.last().status === 'working');
  fh.status('w1:p1', 'idle');
  await until(() => t.last().herdrStatus === 'idle');
  check('the NEXT finish is news again', t.last().status === 'done');

  // pane_updated carries a title; its agent_status is not trusted. Real herdr
  // changes its state before it emits, so a later snapshot agrees.
  fh.state.agents[0].terminal_title_stripped = 'Refactor thing';
  fh.push('pane_updated', { type: 'pane_updated', pane: { pane_id: 'w1:p1', agent_status: 'unknown',
    terminal_title_stripped: 'Refactor thing', cwd: 'C:\\work' } });
  await until(() => t.last().title === 'Refactor thing');
  check('pane_updated moves the title', t.last().title === 'Refactor thing');
  check('pane_updated agent_status is not believed', t.last().herdrStatus === 'idle', t.last().herdrStatus);

  // pane set change -> resubscribe naming the new pane
  fh.state.panes = ['w1:p1', 'w1:p2'];
  fh.state.agents.push(agentInfo('w1:p2', 'working', { focused: false }));
  const subsBefore = fh.subscribeRequests.length;
  fh.push('pane_created', { type: 'pane_created', pane: { pane_id: 'w1:p2' } });
  await until(() => fh.subscribeRequests.length > subsBefore &&
    fh.subscribeRequests[fh.subscribeRequests.length - 1].subscriptions.some(s => s.pane_id === 'w1:p2'));
  check('a new pane is resubscribed by id',
    fh.subscribeRequests[fh.subscribeRequests.length - 1].subscriptions.some(s => s.pane_id === 'w1:p2'));
  await until(() => t.last().feed === 'events');
  fh.status('w1:p2', 'blocked');
  await until(() => t.last().status === 'blocked');
  check('the new pane\'s status arrives', t.last().status === 'blocked' && t.last().paneId === 'w1:p2');

  // --- pipe drop (herdr alive): poll fallback, then resubscribe ----
  console.log('\n=== dropped subscription ===');
  const r0 = t.last().reconnects;
  fh.subscribeRequests.length = 0;
  // Keep the server refusing new subscriptions for a moment so the poll is
  // what carries the change.
  fh.rejectSubscribe = true;
  fh.dropSubs();
  await until(() => t.views.some(v => v.feed === 'poll'));
  check('a dropped pipe falls back to polling', t.views.some(v => v.feed === 'poll'));
  fh.state.agents.find(a => a.pane_id === 'w1:p2').agent_status = 'working';
  t0 = Date.now();
  await until(() => t.last().status === 'working' && t.last().feed === 'poll');
  check('the poll carries a status change while unsubscribed', t.last().status === 'working',
    `${Date.now() - t0}ms at pollMs=100`);
  check('SUBSCRIBE_REJECTED audited once, not per retry',
    t.audits.filter(a => a.includes('SUBSCRIBE_REJECTED:')).length === 1,
    `${fh.subscribeRequests.length} rejected attempts`);
  fh.rejectSubscribe = false;
  await until(() => t.last().feed === 'events', 3000);
  check('resubscribes once herdr accepts again', t.last().feed === 'events' && t.last().reconnects === r0 + 1,
    `reconnects ${r0} -> ${t.last().reconnects}`);
  check('the recovery is audited', t.audits.some(a => /SUBSCRIBE_REJECTED recovered after \d+/.test(a)));

  // --- herdr restart: server gone, then back on the same pipe ------
  console.log('\n=== herdr restart ===');
  const auditMark = t.audits.length;
  await fh.close();
  await until(() => t.last().feed === 'down');
  check('herdr gone -> feed down, status unknown (not the last known state)',
    t.last().feed === 'down' && t.last().status === 'unknown',
    JSON.stringify({ feed: t.last().feed, status: t.last().status }));
  await sleep(600); // several failed reconnects + polls
  const connectAudits = t.audits.slice(auditMark).filter(a => /CONNECT_FAIL:|POLL_FAIL:|DROPPED:/.test(a));
  check('a dead herdr is audited once per failure kind, not per attempt',
    connectAudits.length <= 3, connectAudits.join(' | '));
  const restarted = fakeHerdr(pipe);
  restarted.state = { panes: ['w1:p1'], agents: [agentInfo('w1:p1', 'idle')] };
  await restarted.listen();
  t0 = Date.now();
  await until(() => t.last().feed === 'events', 3000);
  check('the feed resumes after the restart', t.last().feed === 'events' && t.last().status === 'idle',
    `${Date.now() - t0}ms (backoff cap 200ms in test, 5000ms in prod)`);
  restarted.status('w1:p1', 'working');
  await until(() => t.last().status === 'working');
  check('events flow on the new subscription', t.last().status === 'working');

  // --- bootstrap race: an event between subscribe and the snapshot -
  console.log('\n=== bootstrap replay ===');
  t.feed.stop();
  const racePipe = pipeName();
  const race = fakeHerdr(racePipe);
  race.state = { panes: ['w1:p1'], agents: [agentInfo('w1:p1', 'working')] };
  // The snapshot taken once the subscription is live is slow and STALE: herdr
  // answers 'working' from state captured before the event pushed meanwhile.
  race.onSnapshot = () => {
    if (race.subs.length >= 1 && !race.fired) {
      race.fired = true;
      race.snapshotDelayMs = 150;
      setTimeout(() => race.status('w1:p1', 'blocked'), 20);
    } else race.snapshotDelayMs = 0;
  };
  await race.listen();
  const t2 = feedFor(racePipe);
  t2.feed.start();
  await until(() => t2.last() && t2.last().feed === 'events');
  await sleep(100);
  check('an event that raced the bootstrap snapshot is replayed, not lost',
    race.fired && t2.last().status === 'blocked', `fired=${race.fired} status=${t2.last().status}`);
  t2.feed.stop();
  await race.close();

  // --- a finish while the subscription is down ---------------------
  // herdr stays up; only the subscription drops. The turn ending must still
  // read as an unseen finish once the poll (or the resubscribe) sees idle --
  // and an idle that was already seen must stay plain idle across the same.
  console.log('\n=== finish across a dropped subscription ===');
  const dropPipe = pipeName();
  const dh = fakeHerdr(dropPipe);
  dh.state = { panes: ['w1:p1'], agents: [agentInfo('w1:p1', 'working')] };
  await dh.listen();
  const t5 = feedFor(dropPipe);
  t5.feed.start();
  await until(() => t5.last() && t5.last().feed === 'events' && t5.last().status === 'working');
  dh.rejectSubscribe = true;
  dh.dropSubs();
  await until(() => t5.views.some(v => v.feed === 'down'));
  dh.state.agents[0].agent_status = 'idle';
  await until(() => t5.last().feed === 'poll' && t5.last().herdrStatus === 'idle');
  check('working -> (drop) -> idle seen by the poll reads done, unseen',
    t5.last().feed === 'poll' && t5.last().status === 'done' && t5.last().seen === false,
    JSON.stringify({ feed: t5.last().feed, status: t5.last().status, seen: t5.last().seen }));
  dh.rejectSubscribe = false;
  await until(() => t5.last().feed === 'events');
  check('the unseen finish survives the resubscribe',
    t5.last().feed === 'events' && t5.last().status === 'done' && t5.last().seen === false,
    JSON.stringify({ feed: t5.last().feed, status: t5.last().status }));
  t5.feed.markSeen();
  check('viewed -> idle', t5.last().status === 'idle' && t5.last().seen === true);
  dh.rejectSubscribe = true;
  const mark5 = t5.views.length;
  dh.dropSubs();
  await until(() => t5.views.slice(mark5).some(v => v.feed === 'poll'));
  dh.rejectSubscribe = false;
  await until(() => t5.views.slice(mark5).some(v => v.feed === 'poll') && t5.last().feed === 'events');
  check('an already-seen idle stays idle across a drop, poll and reconnect',
    t5.views.slice(mark5).every(v => v.status !== 'done') && t5.last().feed === 'events'
      && t5.last().status === 'idle',
    t5.views.slice(mark5).map(v => `${v.feed}:${v.status}`).join(' '));
  t5.feed.stop();
  await dh.close();

  // --- onChange throwing never escapes -----------------------------
  console.log('\n=== containment ===');
  const audits3 = [];
  const f3 = createAgentFeed({ socketPath: pipe, label: 'x', audit: (k, m) => audits3.push(m),
    onChange: () => { throw new Error('boom'); }, pollMs: 100, backoffMinMs: 50, backoffMaxMs: 200 });
  let escaped = false;
  process.once('uncaughtException', () => { escaped = true; });
  f3.start();
  await sleep(300);
  f3.stop();
  check('an onChange that throws is audited, not thrown', !escaped && audits3.some(m => m.includes('boom')));

  // no pipe at all: never throws, reads down/unknown
  const t4 = feedFor(pipeName());
  t4.feed.start();
  await until(() => t4.last() && t4.last().feed === 'down');
  check('no herdr at all -> down/unknown, no throw', t4.last().feed === 'down' && t4.last().status === 'unknown');
  t4.feed.stop();

  await restarted.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
