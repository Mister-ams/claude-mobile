/**
 * The git branch of a directory, read from the files -- git is never spawned.
 *
 * herdr reports a pane's cwd and worktree but no branch, and a session row
 * must show one (T07). Spawning `git` per session per status change is a
 * process per event on Windows; the answer is two small file reads:
 *
 *   1. walk up from the cwd to the first `.git`: a directory (a normal repo)
 *      or a file holding `gitdir: <path>` (a linked worktree or submodule,
 *      path relative to the file's directory or absolute);
 *   2. read `<gitdir>/HEAD`: `ref: refs/heads/<name>` -> name, a bare object
 *      id (detached HEAD) -> its first 7 characters; no repo -> null.
 *
 * The walk is cached per cwd; HEAD is re-read on every call, so a checkout of
 * another branch shows up the next time the caller asks (server.js asks when
 * herdr reports a change for the session, and on every session-list build).
 * A cached "no repo" is re-walked only when the caller passes refresh, so a
 * `git init` in a session's directory is picked up on its next status change.
 *
 * Never throws: an unreadable repository is reported as no branch.
 */
'use strict';

const fsDefault = require('fs');
const path = require('path');

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/** HEAD file contents -> branch label, or null. Pure; exported for the test. */
function parseHead(text) {
  const t = String(text || '').trim();
  const m = /^ref:\s*(\S+)$/.exec(t);
  if (m) {
    const ref = m[1];
    if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length) || null;
    return ref.replace(/^refs\//, '') || null;
  }
  return OBJECT_ID.test(t) ? t.slice(0, 7) : null;
}

/** The HEAD file governing `cwd`, or null when cwd is not in a repository. */
function findHead(cwd, fs = fsDefault) {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch (e) { /* not here: keep walking */ }
    if (st && st.isDirectory()) return path.join(dotGit, 'HEAD');
    if (st && st.isFile()) {
      let text;
      try { text = fs.readFileSync(dotGit, 'utf8'); } catch (e) { return null; }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      return m ? path.join(path.resolve(dir, m[1]), 'HEAD') : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function createBranchResolver(opts = {}) {
  const fs = opts.fs || fsDefault;
  const heads = new Map();   // cwd -> HEAD path | null

  function branchOf(cwd, { refresh = false } = {}) {
    if (!cwd || typeof cwd !== 'string') return null;
    if (!heads.has(cwd) || (refresh && heads.get(cwd) === null)) heads.set(cwd, findHead(cwd, fs));
    const head = heads.get(cwd);
    if (!head) return null;
    try { return parseHead(fs.readFileSync(head, 'utf8')); }
    catch (e) {
      heads.delete(cwd);     // repository moved or removed: walk again next time
      return null;
    }
  }

  return { branchOf };
}

module.exports = { createBranchResolver, parseHead, findHead };
