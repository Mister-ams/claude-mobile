/**
 * herdr agent-status feed -- one per claude-mobile session on the herdr backend.
 *
 * Decision D7: session status comes from herdr, not from regexes over pty
 * output. herdr already classifies the agent in each pane (blocked / working /
 * done / idle / unknown); this module keeps a live copy of that for ONE herdr
 * named session and reports it, normalised, through onChange.
 *
 * -- Transport (measured on herdr 0.8.2, 2026-09-22) --------------
 *
 * Newline-delimited JSON over the session's API socket. On Windows that is a
 * named pipe whose name is `\\.\pipe\` + the `socket_path` from
 * `herdr session list --json` (the file at socket_path only holds a pid:nonce).
 * A connection answers ONE request and closes -- except `events.subscribe`,
 * which answers `subscription_started` and then streams events until either
 * side closes. So there are two kinds of connection here:
 *
 *   the subscription   long-lived, one per session
 *   one-shot requests  `session.snapshot`, opened and closed per call
 *
 * `pane.agent_status_changed` must name a pane_id (it is required by the
 * schema), so the subscription is rebuilt whenever the pane set changes.
 * `pane.updated` payloads carry title and cwd, but their agent_status is NOT
 * trusted: measured, the first one after subscribing said `unknown` while
 * `agent list` said `blocked`. Status is taken only from agent_status_changed
 * and from snapshots.
 *
 * Bootstrap per (re)connect: snapshot (to learn the panes) -> subscribe ->
 * snapshot again -> replay what arrived in between. Replaying in order is safe
 * without sequence numbers: an event older than the snapshot was already folded
 * into it, and any newer one ends up last.
 *
 * -- When the subscription is down --------------------------------
 *
 * A dropped pipe (herdr restarting, crashing, being upgraded) reconnects with
 * capped exponential backoff. While it is down, a `session.snapshot` poll --
 * the API form of `herdr agent list`, plus workspaces for the worktree -- runs
 * every POLL_MS so a status change still lands within 2s whenever herdr can
 * answer at all. When herdr cannot answer either, the status is reported as
 * `unknown` with feed `down`: an unreachable herdr is not evidence the agent
 * is still doing whatever it was last seen doing.
 *
 * -- "done clears when viewed" ------------------------------------
 *
 * herdr's own seen-state is not usable here: claude-mobile's pty IS a herdr
 * client with the session's only tab focused, so herdr marks every finish seen
 * the moment it happens and reports `idle`, not `done`. So `done` is derived
 * locally: a finish (working/blocked -> idle/done) that happened after the last
 * markSeen() is reported as `done`; markSeen() turns it into `idle`. herdr's
 * seen-state is never written (that would need a focus call, which moves the
 * operator's focus when a pane is split).
 *
 * Never throws into the caller. Every failure mode is audited once per streak
 * with a reason code, and the recovery is audited with the streak length.
 */
'use strict';

const netDefault = require('net');

const STATUSES = ['blocked', 'working', 'done', 'idle', 'unknown'];
// Which pane speaks for the session when there are several: the one most in
// need of the operator.
const PRIORITY = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

function pipePathFor(socketPath, platform = process.platform) {
  if (platform !== 'win32') return socketPath;
  return socketPath.startsWith('\\\\.\\pipe\\') ? socketPath : '\\\\.\\pipe\\' + socketPath;
}

function normStatus(s) {
  return STATUSES.includes(s) ? s : 'unknown';
}

function normWorktree(w) {
  if (!w || typeof w !== 'object') return null;
  return {
    repo: w.repo_name || null,
    root: w.repo_root || null,
    path: w.checkout_path || null,
    linked: w.is_linked_worktree === true,
  };
}

/**
 * Snapshot (session.snapshot result.snapshot) -> { panes, agents, worktrees }.
 * Pure; exported for the unit test.
 */
function normaliseSnapshot(snap) {
  if (!snap || !Array.isArray(snap.panes) || !Array.isArray(snap.agents)) {
    throw new Error('snapshot missing panes/agents arrays');
  }
  const worktrees = new Map();
  for (const w of snap.workspaces || []) worktrees.set(w.workspace_id, normWorktree(w.worktree));
  const agents = new Map();
  for (const a of snap.agents) {
    if (!a || typeof a.pane_id !== 'string') continue;
    agents.set(a.pane_id, {
      paneId: a.pane_id,
      workspaceId: a.workspace_id || null,
      agent: a.agent || null,
      status: normStatus(a.agent_status),
      title: a.terminal_title_stripped || a.terminal_title || null,
      cwd: a.foreground_cwd || a.cwd || null,
      agentSessionId: (a.agent_session && a.agent_session.value) || null,
      seq: Number.isInteger(a.state_change_seq) ? a.state_change_seq : null,
      focused: a.focused === true,
    });
  }
  const panes = snap.panes.map(p => p && p.pane_id).filter(id => typeof id === 'string').sort();
  const paneInfo = new Map();
  for (const p of snap.panes) {
    if (!p || typeof p.pane_id !== 'string') continue;
    paneInfo.set(p.pane_id, {
      workspaceId: p.workspace_id || null,
      title: p.terminal_title_stripped || p.terminal_title || null,
      cwd: p.cwd || null,
      focused: p.focused === true,
    });
  }
  return { panes, agents, worktrees, paneInfo };
}

/** The pane that speaks for the session. Pure; exported for the unit test. */
function primaryAgent(agents) {
  let best = null;
  for (const a of agents.values()) {
    if (!best) { best = a; continue; }
    const d = PRIORITY[a.status] - PRIORITY[best.status];
    if (d < 0 || (d === 0 && a.focused && !best.focused)) best = a;
  }
  return best;
}

/**
 * One-shot request: connect, write one line, read one line, close.
 * Resolves the parsed response; rejects with err.reason set.
 */
function request(net, pipePath, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const sock = net.connect(pipePath);
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(val);
    };
    const fail = (reason, msg) => { const e = new Error(msg); e.reason = reason; finish(e); };
    const timer = setTimeout(() => fail('REQUEST_TIMEOUT', `${method}: no answer in ${timeoutMs}ms`), timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id: `cm:${method}`, method, params: params || {} }) + '\n');
    });
    sock.on('data', d => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, i)); }
      catch (e) { return fail('PARSE', `${method}: unparseable response`); }
      if (msg.error) return fail('API_ERROR', `${method}: ${msg.error.code || ''} ${msg.error.message || ''}`.trim());
      if (!msg.result) return fail('PARSE', `${method}: response has no result`);
      finish(null, msg.result);
    });
    sock.on('error', e => fail('CONNECT', `${method}: ${e.code || e.message}`));
    sock.on('close', () => fail('CLOSED', `${method}: closed before answering`));
  });
}

/**
 * opts: {
 *   socketPath   herdr session socket_path (from `herdr session list --json`)
 *   label        e.g. 'cm-3', for audit lines
 *   audit        (kind, msg) => void
 *   onChange     (view) => void, called whenever the view changes
 *   net, pollMs, backoffMinMs, backoffMaxMs, requestTimeoutMs, platform  (tests)
 * }
 */
function createAgentFeed(opts) {
  const net = opts.net || netDefault;
  const label = opts.label || 'herdr';
  const audit = opts.audit || (() => {});
  const onChange = opts.onChange || (() => {});
  const POLL_MS = opts.pollMs || 1500;
  const BACKOFF_MIN = opts.backoffMinMs || 250;
  const BACKOFF_MAX = opts.backoffMaxMs || 5000;
  const REQ_TIMEOUT = opts.requestTimeoutMs || 3000;
  const pipePath = pipePathFor(opts.socketPath, opts.platform);

  let stopped = true;
  let sub = null;             // live subscription socket
  let subPanes = [];          // pane ids the live subscription names
  let feed = 'down';          // 'events' | 'poll' | 'down'
  let reconnects = 0;
  let backoff = BACKOFF_MIN;
  let reconnectTimer = null;
  let pollTimer = null;
  let refreshTimer = null;
  let eventGen = 0;           // bumped by every status event
  let connecting = false;

  // Model
  let agents = new Map();
  let paneInfo = new Map();
  let worktrees = new Map();
  let panes = [];
  let knowsAnything = false;

  // Seen tracking (see header): a finish nobody has looked at yet.
  let lastRaw = null;
  let unseenFinish = false;

  // Failure streaks: audit the first failure of a kind, and the recovery.
  const streaks = new Map();
  function failure(reason, msg) {
    const n = (streaks.get(reason) || 0) + 1;
    streaks.set(reason, n);
    if (n === 1) audit('HERDR-EV', `${label} ${reason}: ${msg}`);
  }
  function recovered(reasons) {
    for (const r of reasons) {
      const n = streaks.get(r);
      if (n) { audit('HERDR-EV', `${label} ${r} recovered after ${n} failure(s)`); streaks.delete(r); }
    }
  }

  let lastViewJson = null;
  function view() {
    const p = feed === 'down' ? null : primaryAgent(agents);
    const raw = !knowsAnything || feed === 'down' ? 'unknown' : (p ? p.status : 'unknown');
    let status = raw;
    if (raw === 'idle' || raw === 'done') status = unseenFinish ? 'done' : 'idle';
    const info = p ? null : paneInfo.get(panes[0]);
    const wsId = p ? p.workspaceId : (info && info.workspaceId);
    return {
      status,
      herdrStatus: raw,
      seen: status !== 'done',
      agent: p ? p.agent : null,
      title: p ? p.title : (info ? info.title : null),
      cwd: p ? p.cwd : (info ? info.cwd : null),
      worktree: (wsId && worktrees.get(wsId)) || null,
      agentSessionId: p ? p.agentSessionId : null,
      paneId: p ? p.paneId : null,
      seq: p ? p.seq : null,
      feed,
      reconnects,
    };
  }

  function emit() {
    // Seen tracking follows the RAW herdr status. A turn ending is news; a
    // new turn starting supersedes it. On the very first reading herdr's own
    // 'done' is believed (it saw the finish; we did not); its 'idle' is not news.
    // 'unknown' says nothing about turns, so it neither starts nor ends one.
    // A feed that went down has lost track of turns: the next reading is a
    // first reading again, so a herdr restart is not mistaken for a finish.
    if (feed === 'down') lastRaw = null;
    const raw = view().herdrStatus;
    if (raw !== 'unknown' && raw !== lastRaw) {
      if (lastRaw === null) unseenFinish = raw === 'done';
      else if (raw === 'working' || raw === 'blocked') unseenFinish = false;
      else if ((raw === 'idle' || raw === 'done') && (lastRaw === 'working' || lastRaw === 'blocked')) {
        unseenFinish = true;
      }
      lastRaw = raw;
    }
    const out = view();
    const j = JSON.stringify(out);
    if (j === lastViewJson) return;
    lastViewJson = j;
    try { onChange(out); }
    catch (e) { audit('ERROR', `${label} herdr feed onChange threw: ${e.message}`); }
  }

  function applySnapshot(snap) {
    const n = normaliseSnapshot(snap);
    agents = n.agents; paneInfo = n.paneInfo; worktrees = n.worktrees; panes = n.panes;
    knowsAnything = true;
  }

  async function snapshot() {
    const res = await request(net, pipePath, 'session.snapshot', {}, REQ_TIMEOUT);
    if (!res.snapshot) { const e = new Error('session.snapshot: no snapshot in result'); e.reason = 'PARSE'; throw e; }
    return res.snapshot;
  }

  // A refresh after an event: fetch title/cwd/seq/worktree, but never let a
  // snapshot that was ISSUED before a later status event overwrite it.
  function scheduleRefresh(delay) {
    if (refreshTimer || stopped) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (stopped || feed !== 'events') return;
      const gen = eventGen;
      try {
        const snap = await snapshot();
        if (stopped || feed !== 'events') return;
        if (gen !== eventGen) { scheduleRefresh(0); return; }
        applySnapshot(snap);
        recovered(['REFRESH_FAIL']);
        emit();
        if (panes.join(',') !== subPanes.join(',')) resubscribe('pane set changed');
      } catch (e) {
        failure('REFRESH_FAIL', `${e.reason || 'ERROR'} ${e.message}`);
      }
    }, delay);
  }

  function handleEvent(msg) {
    const ev = msg.event;
    const d = msg.data || {};
    if (ev === 'pane.agent_status_changed') {
      eventGen++;
      const a = agents.get(d.pane_id);
      if (a) {
        a.status = normStatus(d.agent_status);
        if (d.agent) a.agent = d.agent;
      } else {
        agents.set(d.pane_id, {
          paneId: d.pane_id, workspaceId: d.workspace_id || null, agent: d.agent || null,
          status: normStatus(d.agent_status), title: d.title || null, cwd: null,
          agentSessionId: null, seq: null, focused: false,
        });
      }
      emit();
      scheduleRefresh(0);
    } else if (ev === 'pane_updated' || ev === 'pane.updated') {
      const p = d.pane || {};
      const a = agents.get(p.pane_id);
      const title = p.terminal_title_stripped || p.terminal_title || null;
      // Newer than any snapshot already in flight: without this, a refresh
      // issued before the event lands after it and restores the old title.
      if (title || p.cwd) eventGen++;
      if (a) { if (title) a.title = title; if (!a.cwd && p.cwd) a.cwd = p.cwd; }
      const info = paneInfo.get(p.pane_id);
      if (info) { if (title) info.title = title; if (p.cwd) info.cwd = p.cwd; }
      if (p.agent && !a) scheduleRefresh(50); // an agent we have not heard of
      emit();
    } else {
      // Structure moved (pane created/closed, agent detected/exited,
      // workspace/worktree changed): refetch the whole picture.
      scheduleRefresh(50);
    }
  }

  function closeSub() {
    if (!sub) return;
    const s = sub;
    sub = null;
    s.removeAllListeners('close');
    s.removeAllListeners('data');
    s.on('error', () => {});
    s.destroy();
  }

  function resubscribe(why) {
    audit('HERDR-EV', `${label} resubscribing: ${why}`);
    closeSub();
    connect();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(BACKOFF_MAX, backoff * 2);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  }

  function startPoll() {
    if (pollTimer || stopped) return;
    const tick = async () => {
      if (stopped || feed === 'events') { pollTimer = null; return; }
      try {
        applySnapshot(await snapshot());
        if (stopped || feed === 'events') { pollTimer = null; return; }
        feed = 'poll';
        recovered(['POLL_FAIL']);
      } catch (e) {
        failure('POLL_FAIL', `${e.reason || 'ERROR'} ${e.message}`);
        if (feed !== 'events') feed = 'down';
      }
      emit();
      if (!stopped && feed !== 'events') pollTimer = setTimeout(tick, POLL_MS);
      else pollTimer = null;
    };
    pollTimer = setTimeout(tick, 0);
  }

  function lost(reason, msg) {
    closeSub();
    if (stopped) return;
    failure(reason, msg);
    if (feed === 'events') feed = 'down';
    emit();
    startPoll();
    scheduleReconnect();
  }

  async function connect() {
    if (stopped || connecting) return;
    connecting = true;
    let first;
    try {
      first = await snapshot();
    } catch (e) {
      connecting = false;
      return lost('CONNECT_FAIL', `${e.reason || 'ERROR'} ${e.message}`);
    }
    if (stopped) { connecting = false; return; }
    const pre = normaliseSnapshot(first);
    const wanted = pre.panes;

    const s = net.connect(pipePath);
    sub = s;
    let buf = '';
    let started = false;
    const pending = [];
    const onFail = (reason, msg) => { if (sub === s) { connecting = false; lost(reason, msg); } };

    s.on('connect', () => {
      const subscriptions = [
        ...wanted.map(pane_id => ({ type: 'pane.agent_status_changed', pane_id })),
        { type: 'pane.created' }, { type: 'pane.closed' }, { type: 'pane.exited' },
        { type: 'pane.updated' }, { type: 'pane.agent_detected' },
        { type: 'workspace.updated' }, { type: 'workspace.closed' },
        { type: 'worktree.created' }, { type: 'worktree.opened' }, { type: 'worktree.removed' },
      ];
      s.write(JSON.stringify({ id: 'cm:subscribe', method: 'events.subscribe', params: { subscriptions } }) + '\n');
    });
    s.on('data', async d => {
      if (sub !== s) return;
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch (e) { failure('PARSE', 'unparseable event line'); continue; }
        if (!started) {
          if (msg.error) {
            return onFail('SUBSCRIBE_REJECTED', `${msg.error.code || ''} ${msg.error.message || ''}`.trim());
          }
          if (msg.result && msg.result.type === 'subscription_started') {
            started = true;
            // Snapshot AFTER the subscription is live, then replay.
            let snap;
            try { snap = await snapshot(); }
            catch (e) { return onFail('SNAPSHOT_FAIL', `${e.reason || 'ERROR'} ${e.message}`); }
            if (sub !== s || stopped) return;
            applySnapshot(snap);
            subPanes = wanted;
            feed = 'events';
            connecting = false;
            if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
            if (reconnects > 0 || streaks.size) {
              audit('HERDR-EV', `${label} subscribed (reconnect #${reconnects})`);
            }
            recovered(['CONNECT_FAIL', 'DROPPED', 'SUBSCRIBE_REJECTED', 'SNAPSHOT_FAIL', 'POLL_FAIL']);
            backoff = BACKOFF_MIN;
            for (const m of pending.splice(0)) handleEvent(m);
            emit();
            if (panes.join(',') !== subPanes.join(',')) resubscribe('pane set changed during bootstrap');
            continue;
          }
          continue;
        }
        if (msg.event) {
          if (feed !== 'events') pending.push(msg);
          else handleEvent(msg);
        }
      }
    });
    s.on('error', e => onFail(started ? 'DROPPED' : 'CONNECT_FAIL', e.code || e.message));
    s.on('close', () => {
      if (sub !== s) return;
      if (started) reconnects++;
      onFail(started ? 'DROPPED' : 'CONNECT_FAIL', 'subscription pipe closed');
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      closeSub();
      for (const t of [reconnectTimer, pollTimer, refreshTimer]) if (t) clearTimeout(t);
      reconnectTimer = pollTimer = refreshTimer = null;
    },
    // The operator has looked at the session: a finish is no longer news.
    markSeen() {
      if (!unseenFinish) return;
      unseenFinish = false;
      emit();
    },
    view,
  };
}

module.exports = { createAgentFeed, normaliseSnapshot, primaryAgent, pipePathFor, STATUSES };
