/**
 * Session backend seam.
 *
 * A backend owns everything about how a claude-mobile session PERSISTS across a
 * server restart, and nothing else. The server owns the WebSocket, the
 * scrollback ring, the headless mirror, attention detection and auth; it talks
 * to whatever is behind this interface the same way either way.
 *
 * Two implementations:
 *   dtach  -- dtach daemons inside WSL, reached by spawning wsl.exe (the
 *             shipped default; 236 restarts survived over five months)
 *   herdr  -- herdr named sessions running natively on Windows under ConPTY,
 *             no WSL in the path at all
 *
 * Selection is `sessionBackend` in config.json, defaulting to dtach. This is
 * the same shape as RENDERER_MODE selecting grid vs xterm: both are shipped,
 * one is default, and backing out is a config edit rather than a revert.
 *
 * ── The contract ─────────────────────────────────────────────────
 *
 *   kind                      'dtach' | 'herdr'
 *   describe()                one line for the startup banner
 *   label(id)                 stable name for audit lines, e.g. 'cm-3'
 *   init()                    begin availability probing (non-blocking)
 *   isAvailable()             last known transport health, for /health
 *   state(id)                 'alive' | 'stale' | 'gone' | 'unknown'
 *   alive(id)                 convenience: state(id) === 'alive'
 *   list()                    { live: number[], phantom: number[] }
 *   create(id, opts)          async -> pty proc for a NEW session
 *   attach(id, opts)          -> pty proc for an EXISTING session (throws)
 *   launchClaude(proc, id)    start Claude inside the freshly created session
 *   closeProc(proc)           drop a pty without leaving an orphan
 *   kill(id)                  destroy the persisted session
 *   probe(ids)                watchdog: { ok, transportDown, detail }
 *
 * ── state() is deliberately four-valued ──────────────────────────
 *
 * 'gone' and 'unknown' are NOT the same answer. 'gone' means the backend was
 * asked and answered that nothing is there; 'unknown' means the backend could
 * not be asked at all. The caller decides a live session's fate from this, so
 * collapsing the two turns a transient WSL hiccup into "your session is dead,
 * cleaned up". `.claude/rules/verification-lessons.md` in loomi-os is a list of
 * a dozen bugs of exactly that shape -- absent data read as a confirmed
 * negative -- so the vocabulary carries the distinction rather than the
 * callers having to remember it.
 */

const createDtachBackend = require('./dtach');
const createHerdrBackend = require('./herdr');

const BACKENDS = {
  dtach: createDtachBackend,
  herdr: createHerdrBackend,
};

/**
 * deps: { config, audit, getSafeEnv, pty, setLastError }
 * Every backend takes the same deps so the server never branches on kind.
 */
function createSessionBackend(deps) {
  const requested = deps.config.sessionBackend || 'dtach';
  const factory = BACKENDS[requested];
  if (!factory) {
    throw new Error(
      `Unknown sessionBackend "${requested}" in config.json. ` +
      `Known: ${Object.keys(BACKENDS).join(', ')}.`);
  }
  return factory(deps);
}

module.exports = { createSessionBackend, BACKENDS };
