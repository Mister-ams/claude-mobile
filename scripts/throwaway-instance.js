#!/usr/bin/env node
/**
 * Throwaway claude-mobile instance for live testing -- up / down.
 *
 *   node scripts/throwaway-instance.js up   [--port 3457] [--prefix cmsim]
 *   node scripts/throwaway-instance.js down [--port 3457] [--prefix cmsim]
 *
 * up    Runs server.js from THIS checkout on --port with the herdr backend and
 *       session prefix --prefix, as a plain detached node process -- never pm2,
 *       so nothing can land in the pm2 reboot dump. Writes config.json, waits
 *       for /health, mints the instance's OWN TOTP via the localhost-only
 *       /api/setup/init, confirms it via /api/setup/verify, and prints the path
 *       of the file holding the secret -- never the secret.
 *
 * down  Idempotent. Kills the recorded server tree (only after proving the pid
 *       is still the process `up` started), then for every <prefix>-N herdr
 *       session runs `herdr session stop` and `herdr session delete` -- killing
 *       the server does NOT stop a herdr session, they are orphaned on purpose
 *       (lib/session-backend/herdr.js). Verifies none remain, the port is free
 *       and the pid is gone, and removes only the files `up` created.
 *
 * Refuses: port 3456 (the live instance), prefix `cm` (the live sessions), a
 * main checkout (the live instance is one), an existing config.json, a
 * node_modules that is a junction/symlink, a busy port, leftover sessions.
 *
 * No PowerShell anywhere: node APIs, the herdr CLI, git, netstat, tasklist,
 * taskkill.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const LIVE_PORT = 3456;
const REPO = path.resolve(__dirname, '..');
const HERDR = process.env.HERDR_BIN || path.join(os.homedir(), 'tools', 'herdr', 'herdr.exe');
// Everything server.js writes into its own directory; `down` removes only the
// ones that did not exist before `up`.
const INSTANCE_FILES = ['config.json', '.totp-secret', '.credentials.json',
  '.server-identity-key', '.session-meta.json'];
// The recorded start time and the server's own (now - uptime) must agree
// within this before `down` will kill a pid: a recycled pid cannot match both
// the port and the start time.
const START_TOLERANCE_MS = 15000;

function parseArgs(argv) {
  const a = { action: argv[0], port: 3457, prefix: 'cmsim' };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--port') a.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--prefix') a.prefix = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const STATE_DIR = path.join(os.tmpdir(), `cm-sim-${args.port}`);
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WORK_DIR = path.join(STATE_DIR, 'work');
const SESSION_RE = new RegExp(`^${args.prefix}-\\d+$`);

const log = (m) => process.stdout.write(m + '\n');
class Refusal extends Error {}

// ── helpers ─────────────────────────────────────────────────────────────────

function herdrEnv() {
  // An ambient HERDR_SESSION would redirect a call to someone else's session.
  const env = { ...process.env };
  delete env.HERDR_SESSION;
  delete env.HERDR_PANE_ID;
  return env;
}

function herdr(argv) {
  return execFileSync(HERDR, argv, { encoding: 'utf8', timeout: 25000, windowsHide: true, env: herdrEnv() });
}

function ourSessions() {
  const parsed = JSON.parse(herdr(['session', 'list', '--json']));
  if (!Array.isArray(parsed.sessions)) throw new Error('herdr session list returned no sessions array');
  return parsed.sessions.filter(s => SESSION_RE.test(String(s.name || '')));
}

// The pid listening on a port, from netstat (IPv4 and IPv6), or null.
function listenerPid(port) {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    if (cols[1].endsWith(`:${port}`)) return parseInt(cols[4], 10);
  }
  return null;
}

// Image name for a pid, or null if no such process.
function imageOf(pid) {
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true }).trim();
  const m = out.match(/^"([^"]+)","(\d+)"/m);
  return m && parseInt(m[2], 10) === pid ? m[1] : null;
}

function request(method, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port, path: urlPath, method, timeout: 5000,
      headers: data === null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        // requireSameSite wants same-origin evidence; this is the only origin
        // it accepts for a localhost server.
        Origin: `http://localhost:${port}`,
      },
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', c => { s += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(s) }); }
        catch (e) { reject(new Error(`${method} ${urlPath}: HTTP ${res.statusCode}, non-JSON body`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath}: timeout`)));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function health(port) {
  try { return (await request('GET', port, '/health')).json; } catch (e) { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function git(argv) {
  return execFileSync('git', ['-C', REPO, ...argv], { encoding: 'utf8', windowsHide: true }).trim();
}

// ── safety ──────────────────────────────────────────────────────────────────

function assertSafe() {
  if (!['up', 'down'].includes(args.action)) throw new Refusal('usage: throwaway-instance.js up|down [--port N] [--prefix p]');
  if (!Number.isInteger(args.port) || args.port <= 0) throw new Refusal(`bad port ${args.port}`);
  if (args.port === LIVE_PORT) throw new Refusal(`port ${LIVE_PORT} is the live instance`);
  if (!/^[a-z][a-z0-9]*$/.test(args.prefix)) throw new Refusal(`prefix '${args.prefix}' must be lowercase alphanumeric`);
  if (args.prefix === 'cm') throw new Refusal("prefix 'cm' is the live instance's");
  if (!fs.existsSync(HERDR)) throw new Refusal(`herdr not found at ${HERDR}`);
}

// ── down ────────────────────────────────────────────────────────────────────

async function down() {
  const problems = [];
  const state = readState();

  // 1. the server tree -- only if the pid is provably still ours
  if (state && state.pid) {
    const pid = state.pid;
    const image = imageOf(pid);
    if (!image) {
      log(`server pid ${pid} already gone`);
    } else {
      const h = await health(args.port);
      const owner = listenerPid(args.port);
      const startedByServer = h ? Date.now() - h.uptime * 1000 : null;
      const sameStart = startedByServer !== null &&
        Math.abs(startedByServer - state.startedAtMs) < START_TOLERANCE_MS;
      if (image.toLowerCase() === 'node.exe' && owner === pid && sameStart) {
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
        } catch (e) { /* verified below */ }
        for (let i = 0; i < 20 && imageOf(pid); i++) await sleep(250);
        if (imageOf(pid)) problems.push(`pid ${pid} still running after taskkill`);
        else log(`killed server pid ${pid} (tree); pid gone`);
      } else {
        problems.push(`pid ${pid} is ${image}, port owner ${owner}, start match ${sameStart} -- ` +
          'not provably the server `up` started, NOT killing it');
      }
    }
  }
  const stray = listenerPid(args.port);
  if (stray && !(state && state.pid === stray)) {
    problems.push(`port ${args.port} held by pid ${stray}, not recorded by up -- not killing it`);
  }

  // 2. herdr sessions: stop, wait until not running, delete
  for (const s of ourSessions()) {
    if (s.running) {
      try { herdr(['session', 'stop', s.name, '--json']); log(`herdr session stop ${s.name}`); }
      catch (e) { problems.push(`herdr session stop ${s.name}: ${e.message.split('\n')[0]}`); }
      for (let i = 0; i < 30; i++) {
        if (!ourSessions().some(x => x.name === s.name && x.running)) break;
        await sleep(500);
      }
    }
    try { herdr(['session', 'delete', s.name, '--json']); log(`herdr session delete ${s.name}`); }
    catch (e) { problems.push(`herdr session delete ${s.name}: ${e.message.split('\n')[0]}`); }
  }
  const left = ourSessions();
  if (left.length) problems.push(`herdr sessions remain: ${left.map(s => s.name).join(', ')}`);

  // 3. the port
  for (let i = 0; i < 20 && listenerPid(args.port); i++) await sleep(500);
  const still = listenerPid(args.port);
  if (still) problems.push(`port ${args.port} still listening (pid ${still})`);

  // 4. instance files this run created
  if (state && Array.isArray(state.createdFiles)) {
    for (const f of state.createdFiles) {
      const fp = path.join(REPO, f);
      if (fs.existsSync(fp) && fs.lstatSync(fp).isFile()) { fs.unlinkSync(fp); log(`removed ${f}`); }
    }
  }

  if (problems.length) {
    for (const p of problems) log(`FAIL: ${p}`);
    return 1;
  }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  log(`down: no ${args.prefix}-* sessions, port ${args.port} free (logs kept in ${STATE_DIR})`);
  return 0;
}

// ── up ──────────────────────────────────────────────────────────────────────

async function up() {
  // Refusals first -- nothing is written until every one has passed.
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (path.resolve(gitDir) === path.resolve(common)) {
    throw new Refusal(`${REPO} is a main checkout, not a linked worktree (the live instance is a main checkout)`);
  }
  const nm = path.join(REPO, 'node_modules');
  if (!fs.existsSync(nm)) throw new Refusal(`no node_modules in ${REPO} -- run npm ci there first`);
  // Node reports a Windows junction as a symbolic link.
  if (fs.lstatSync(nm).isSymbolicLink()) throw new Refusal('node_modules is a junction/symlink -- this checkout needs its own install');
  if (!fs.existsSync(path.join(nm, 'node-pty'))) throw new Refusal('node-pty missing from node_modules');
  if (fs.existsSync(path.join(REPO, 'config.json'))) throw new Refusal(`config.json already exists in ${REPO} -- refusing to overwrite it`);
  if (fs.existsSync(STATE_FILE)) throw new Refusal(`state file ${STATE_FILE} exists -- run 'down' first`);
  const busy = listenerPid(args.port);
  if (busy) throw new Refusal(`port ${args.port} is in use (pid ${busy})`);
  const stale = ourSessions();
  if (stale.length) throw new Refusal(`leftover herdr sessions ${stale.map(s => s.name).join(', ')} -- run 'down' first`);

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const createdFiles = INSTANCE_FILES.filter(f => !fs.existsSync(path.join(REPO, f)));
  const config = {
    port: args.port,
    inactivityTimeout: 15,
    sessionBackend: 'herdr',
    sessionPrefix: args.prefix,
    herdrBin: HERDR,
    auditPath: path.join(STATE_DIR, 'audit.log'),
    autoStart: [],
    defaultDir: WORK_DIR,
    projects: [{ name: args.prefix, dir: WORK_DIR }],
  };
  // No BOM: JSON.parse in server.js rejects one.
  fs.writeFileSync(path.join(REPO, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  const state = { port: args.port, prefix: args.prefix, repo: REPO, pid: null, startedAtMs: null, createdFiles };
  writeState(state);

  try {
    const out = fs.openSync(path.join(STATE_DIR, 'server.out.log'), 'a');
    const err = fs.openSync(path.join(STATE_DIR, 'server.err.log'), 'a');
    const env = herdrEnv();
    env.PORT = String(args.port);
    state.startedAtMs = Date.now();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO, env, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    child.unref();
    fs.closeSync(out); fs.closeSync(err);
    state.pid = child.pid;
    writeState(state);
    log(`server pid ${child.pid} on port ${args.port} (logs in ${STATE_DIR})`);

    let h = null;
    for (const deadline = Date.now() + 30000; !h && Date.now() < deadline;) {
      if (exited !== null) throw new Error(`server exited (code ${exited}); see ${path.join(STATE_DIR, 'server.err.log')}`);
      h = await health(args.port);
      if (!h) await sleep(500);
    }
    if (!h) throw new Error(`no /health on ${args.port} within 30s`);
    if (h.backend !== 'herdr') throw new Error(`backend is '${h.backend}', expected herdr`);
    if (listenerPid(args.port) !== child.pid) throw new Error(`port ${args.port} is not held by pid ${child.pid}`);
    // Pin the start time to the server's own clock, which is what `down` compares.
    state.startedAtMs = Date.now() - h.uptime * 1000;
    writeState(state);
    log(`health: status=${h.status} backend=${h.backend}`);

    // Mint this instance's own TOTP. The response carries the secret; it is
    // dropped here and only the file path is reported.
    const init = await request('POST', args.port, '/api/setup/init', {});
    if (init.status !== 200 || init.json.error) throw new Error(`setup/init: ${init.status} ${init.json.error || ''}`);
    const secretFile = path.join(REPO, '.totp-secret');
    const { TOTP, Secret } = require(path.join(REPO, 'node_modules', 'otpauth'));
    const secret = JSON.parse(fs.readFileSync(secretFile, 'utf8')).secret;
    const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    const ver = await request('POST', args.port, '/api/setup/verify', { code });
    if (!ver.json.verified) throw new Error('setup/verify rejected the code');
    log('totp: minted and verified');
    log(`TOTP_SECRET_FILE=${secretFile}`);
    log(`up: http://localhost:${args.port}  prefix ${args.prefix}-*`);
    return 0;
  } catch (e) {
    log(`up failed: ${e.message} -- tearing down`);
    await down();
    return 1;
  }
}

// ── main ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    assertSafe();
    process.exitCode = args.action === 'up' ? await up() : await down();
  } catch (e) {
    log(`${e instanceof Refusal ? 'REFUSED' : 'FAIL'}: ${e.message}`);
    process.exitCode = e instanceof Refusal ? 2 : 1;
  }
})();
