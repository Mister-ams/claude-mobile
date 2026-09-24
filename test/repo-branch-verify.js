#!/usr/bin/env node
// Verification for lib/repo-branch.js (T07 fix round): the branch a session
// row shows, read from .git files without spawning git. Temp directories
// only, laid out the way git writes them. The live harness
// (test/ipad-webkit-live.py, sidepane-status) checks the same reader against
// a real `git init` repo: the throwaway instance's work dir.
//
//   node test/repo-branch-verify.js      (npm run test:repo-branch)

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBranchResolver, parseHead } = require('../lib/repo-branch');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-repo-branch-'));
const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const SHA = '0123456789abcdef0123456789abcdef01234567';

try {
  console.log('\n=== HEAD parsing ===');
  check('ref to a branch', parseHead('ref: refs/heads/main\n'), 'main');
  check('branch with slashes', parseHead('ref: refs/heads/feat/claude-mobile-next\n'), 'feat/claude-mobile-next');
  check('detached HEAD -> first 7 of the sha', parseHead(SHA + '\n'), '0123456');
  check('garbage -> null', parseHead('not a head'), null);

  const r = createBranchResolver();

  console.log('\n=== layouts ===');
  const repo = mk('repo');
  put(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  check('normal repo', r.branchOf(repo), 'main');
  const nested = mk('repo', 'src', 'lib', 'deep');
  check('nested cwd walks up to the repo', r.branchOf(nested), 'main');

  // Linked worktree: .git is a FILE pointing at <main>/.git/worktrees/<name>,
  // absolute (as `git worktree add` writes it) and relative.
  const wtGit = path.join(repo, '.git', 'worktrees', 'wt1');
  put(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feat/wt-branch\n');
  const wt = mk('wt1');
  put(path.join(wt, '.git'), 'gitdir: ' + wtGit.replace(/\\/g, '/') + '\n');
  check('worktree (.git file, absolute gitdir)', r.branchOf(wt), 'feat/wt-branch');
  check('nested cwd inside the worktree', r.branchOf(mk('wt1', 'a', 'b')), 'feat/wt-branch');
  const wt2Git = path.join(repo, '.git', 'worktrees', 'wt2');
  put(path.join(wt2Git, 'HEAD'), 'ref: refs/heads/rel\n');
  const wt2 = mk('wt2');
  put(path.join(wt2, '.git'), 'gitdir: ../repo/.git/worktrees/wt2\n');
  check('worktree (.git file, relative gitdir)', r.branchOf(wt2), 'rel');

  const det = mk('detached');
  put(path.join(det, '.git', 'HEAD'), SHA + '\n');
  check('detached HEAD', r.branchOf(det), '0123456');

  const none = mk('plain', 'dir');
  check('no repo -> null', r.branchOf(none), null);
  check('empty cwd -> null', r.branchOf(''), null);
  check('missing cwd -> null, no throw', r.branchOf(path.join(root, 'does', 'not', 'exist')), null);

  console.log('\n=== changes ===');
  put(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  check('a branch switch shows on the next read (HEAD re-read)', r.branchOf(nested), 'other');
  put(path.join(none, '.git', 'HEAD'), 'ref: refs/heads/late\n');
  check('a cached "no repo" is not re-walked without refresh', r.branchOf(none), null);
  check('... and is with refresh', r.branchOf(none, { refresh: true }), 'late');
  fs.rmSync(path.join(det, '.git'), { recursive: true, force: true });
  check('a removed repository reads null', r.branchOf(det), null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
