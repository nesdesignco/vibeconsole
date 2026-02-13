const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const gitChangesManager = require('../src/main/gitChangesManager');

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(`${cmd} ${args.join(' ')} failed: ${stderr || error.message}`);
        wrapped.stdout = stdout;
        wrapped.stderr = stderr;
        wrapped.code = error.code;
        reject(wrapped);
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function runCommandAllowFail(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim()
      });
    });
  });
}

async function git(cwd, ...args) {
  return runCommand('git', args, cwd);
}

async function gitAllowFail(cwd, ...args) {
  return runCommandAllowFail('git', args, cwd);
}

async function initRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    await git(repoDir, 'init', '-b', 'main');
  } catch {
    await git(repoDir, 'init');
  }
  await git(repoDir, 'config', 'user.name', 'Test User');
  await git(repoDir, 'config', 'user.email', 'test@example.com');
  try {
    const { stdout } = await git(repoDir, 'branch', '--show-current');
    return stdout || 'main';
  } catch {
    return 'main';
  }
}

function createTempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-${name}-`));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('applyGitHunk stages, unstages, and discards a single hunk', async (t) => {
  const repoDir = createTempDir(t, 'hunk');
  await initRepo(repoDir);

  const filePath = path.join(repoDir, 'app.txt');
  fs.writeFileSync(filePath, 'one\ntwo\nthree\n', 'utf8');
  await git(repoDir, 'add', 'app.txt');
  await git(repoDir, 'commit', '-m', 'initial');

  fs.writeFileSync(filePath, 'one\ntwo changed\nthree\n', 'utf8');

  const diffResult = await gitChangesManager.loadDiff(repoDir, 'app.txt', 'unstaged');
  assert.equal(diffResult.error, null);
  const hunks = gitChangesManager.extractHunkPatches(diffResult.diff);
  assert.ok(hunks.length > 0);

  const stageResult = await gitChangesManager.applyGitHunk(repoDir, 'app.txt', 'unstaged', 'stage', hunks[0].patch);
  assert.equal(stageResult.error, null);

  const afterStage = await gitChangesManager.loadChanges(repoDir);
  assert.ok(afterStage.staged.some(item => item.path === 'app.txt'));

  const unstageResult = await gitChangesManager.applyGitHunk(repoDir, 'app.txt', 'staged', 'unstage', hunks[0].patch);
  assert.equal(unstageResult.error, null);

  const afterUnstage = await gitChangesManager.loadChanges(repoDir);
  assert.ok(!afterUnstage.staged.some(item => item.path === 'app.txt'));

  let discardPatch = hunks[0].patch;
  if (!afterUnstage.unstaged.some(item => item.path === 'app.txt')) {
    fs.writeFileSync(filePath, 'one\ntwo changed\nthree\n', 'utf8');
    const refreshedDiff = await gitChangesManager.loadDiff(repoDir, 'app.txt', 'unstaged');
    const refreshedHunks = gitChangesManager.extractHunkPatches(refreshedDiff.diff);
    assert.ok(refreshedHunks.length > 0);
    discardPatch = refreshedHunks[0].patch;
  }

  const discardResult = await gitChangesManager.applyGitHunk(repoDir, 'app.txt', 'unstaged', 'discard', discardPatch);
  assert.equal(discardResult.error, null);

  const afterDiscard = await gitChangesManager.loadChanges(repoDir);
  assert.ok(!afterDiscard.staged.some(item => item.path === 'app.txt'));
  assert.ok(!afterDiscard.unstaged.some(item => item.path === 'app.txt'));
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'one\ntwo\nthree\n');
});

test('loadGitConflict and resolveGitConflict handle merge conflicts', async (t) => {
  const repoDir = createTempDir(t, 'conflict');
  const baseBranch = await initRepo(repoDir);

  const filePath = path.join(repoDir, 'conflict.txt');
  fs.writeFileSync(filePath, 'line\n', 'utf8');
  await git(repoDir, 'add', 'conflict.txt');
  await git(repoDir, 'commit', '-m', 'base');

  await git(repoDir, 'checkout', '-b', 'feature');
  fs.writeFileSync(filePath, 'feature line\n', 'utf8');
  await git(repoDir, 'add', 'conflict.txt');
  await git(repoDir, 'commit', '-m', 'feature change');

  await git(repoDir, 'checkout', baseBranch);
  fs.writeFileSync(filePath, 'main line\n', 'utf8');
  await git(repoDir, 'add', 'conflict.txt');
  await git(repoDir, 'commit', '-m', 'main change');

  const mergeResult = await gitAllowFail(repoDir, 'merge', 'feature');
  assert.notEqual(mergeResult.code, 0);

  const conflictDetails = await gitChangesManager.loadGitConflict(repoDir, 'conflict.txt');
  assert.equal(conflictDetails.error, null);
  assert.ok(conflictDetails.ours.includes('main line'));
  assert.ok(conflictDetails.theirs.includes('feature line'));

  const resolveResult = await gitChangesManager.resolveGitConflict(repoDir, 'conflict.txt', 'resolved line\n');
  assert.equal(resolveResult.error, null);

  const changes = await gitChangesManager.loadChanges(repoDir);
  assert.equal(changes.conflicts.length, 0);
  assert.ok(changes.staged.some(item => item.path === 'conflict.txt'));
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'resolved line\n');
});

test('gitFetch updates incoming commits for tracked branch', async (t) => {
  const baseDir = createTempDir(t, 'fetch');
  const remoteDir = path.join(baseDir, 'remote.git');
  await runCommand('git', ['init', '--bare', remoteDir], baseDir);

  const localDir = path.join(baseDir, 'local');
  await runCommand('git', ['clone', remoteDir, localDir], baseDir);
  await git(localDir, 'config', 'user.name', 'Test User');
  await git(localDir, 'config', 'user.email', 'test@example.com');

  fs.writeFileSync(path.join(localDir, 'notes.txt'), 'v1\n', 'utf8');
  await git(localDir, 'add', 'notes.txt');
  await git(localDir, 'commit', '-m', 'seed');
  const { stdout: localBranch } = await git(localDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  await git(localDir, 'push', '-u', 'origin', localBranch);

  const otherDir = path.join(baseDir, 'other');
  await runCommand('git', ['clone', remoteDir, otherDir], baseDir);
  await git(otherDir, 'config', 'user.name', 'Test User');
  await git(otherDir, 'config', 'user.email', 'test@example.com');
  await git(otherDir, 'checkout', localBranch);
  fs.writeFileSync(path.join(otherDir, 'notes.txt'), 'v2\n', 'utf8');
  await git(otherDir, 'add', 'notes.txt');
  await git(otherDir, 'commit', '-m', 'remote update');
  await git(otherDir, 'push');

  const fetchResult = await gitChangesManager.gitFetch(localDir, true);
  assert.equal(fetchResult.error, null);

  const changes = await gitChangesManager.loadChanges(localDir);
  assert.ok(changes.hasUpstream);
  assert.ok(changes.incomingCommits.length >= 1);
});

test('loadCommitGraph returns graph lanes for branched history', async (t) => {
  const repoDir = createTempDir(t, 'graph');
  const baseBranch = await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'graph.txt'), 'base\n', 'utf8');
  await git(repoDir, 'add', 'graph.txt');
  await git(repoDir, 'commit', '-m', 'base commit');

  await git(repoDir, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(repoDir, 'graph.txt'), 'feature\n', 'utf8');
  await git(repoDir, 'commit', '-am', 'feature commit');

  await git(repoDir, 'checkout', baseBranch);
  fs.writeFileSync(path.join(repoDir, 'main.txt'), 'main\n', 'utf8');
  await git(repoDir, 'add', 'main.txt');
  await git(repoDir, 'commit', '-m', 'main commit');

  await git(repoDir, 'merge', '--no-ff', '-m', 'merge feature', 'feature');

  const graph = await gitChangesManager.loadCommitGraph(repoDir);
  const hashes = Object.keys(graph.byHash || {});
  assert.ok(hashes.length >= 3);
  assert.ok(hashes.some(hash => String(graph.byHash[hash]).includes('*')));
});

test('loadGitActivity returns daily commit activity for recent range', async (t) => {
  const repoDir = createTempDir(t, 'activity');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'activity.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 'activity.txt');
  await git(repoDir, 'commit', '-m', 'activity commit 1');

  fs.writeFileSync(path.join(repoDir, 'activity.txt'), 'v2\n', 'utf8');
  await git(repoDir, 'commit', '-am', 'activity commit 2');

  const activity = await gitChangesManager.loadGitActivity(repoDir, 30);
  assert.ok(Array.isArray(activity.activity));
  assert.ok(activity.activity.length > 0);
  assert.ok(activity.activityTotal >= 2);

  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayKey = `${y}-${m}-${d}`;

  const todayCell = activity.activity.find(item => item.date === todayKey);
  assert.ok(todayCell);
  assert.ok(todayCell.count >= 2);
});

test('undoLastCommit works for initial commit by returning to unborn branch', async (t) => {
  const repoDir = createTempDir(t, 'undo-initial');
  const branch = await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'initial');

  const undo = await gitChangesManager.undoLastCommit(repoDir);
  assert.equal(undo.error, null);

  // Branch should exist but have no commits yet; index should keep the file staged.
  const status = await git(repoDir, 'status', '--porcelain');
  assert.ok(status.stdout.includes('A  a.txt'));

  const head = await gitAllowFail(repoDir, 'rev-parse', 'HEAD');
  assert.notEqual(head.code, 0);

  const current = await git(repoDir, 'branch', '--show-current');
  assert.equal(current.stdout, branch);
});

test('loadChanges includes localCommits when no upstream is configured', async (t) => {
  const repoDir = createTempDir(t, 'local-commits');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'c1');

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v2\n', 'utf8');
  await git(repoDir, 'commit', '-am', 'c2');

  const changes = await gitChangesManager.loadChanges(repoDir);
  assert.equal(changes.error, null);
  assert.equal(changes.hasUpstream, false);
  assert.ok(Array.isArray(changes.localCommits));
  assert.ok(changes.localCommits.length >= 2);
  assert.equal(changes.localCommits[0].message, 'c2');
});

test('stageAll and unstageAll roundtrip changes', async (t) => {
  const repoDir = createTempDir(t, 'stageall');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n', 'utf8');
  await git(repoDir, 'add', 'tracked.txt');
  await git(repoDir, 'commit', '-m', 'base');

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'new.txt'), 'new\n', 'utf8');

  const stageRes = await gitChangesManager.stageAll(repoDir);
  assert.equal(stageRes.error, null);

  const afterStage = await gitChangesManager.loadChanges(repoDir);
  assert.ok(afterStage.staged.some(f => f.path === 'tracked.txt'));
  assert.ok(afterStage.staged.some(f => f.path === 'new.txt'));

  const unstageRes = await gitChangesManager.unstageAll(repoDir);
  assert.equal(unstageRes.error, null);

  const afterUnstage = await gitChangesManager.loadChanges(repoDir);
  assert.equal(afterUnstage.staged.length, 0);
  assert.ok(afterUnstage.unstaged.some(f => f.path === 'tracked.txt'));
  assert.ok(afterUnstage.untracked.some(f => f.path === 'new.txt'));
});

test('discardAllUnstaged restores tracked files and removes untracked files', async (t) => {
  const repoDir = createTempDir(t, 'discardall');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 't.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 't.txt');
  await git(repoDir, 'commit', '-m', 'base');

  fs.writeFileSync(path.join(repoDir, 't.txt'), 'v2\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'u.txt'), 'u1\n', 'utf8');

  const res = await gitChangesManager.discardAllUnstaged(repoDir);
  assert.equal(res.error, null);

  const after = await gitChangesManager.loadChanges(repoDir);
  assert.equal(after.unstaged.length, 0);
  assert.equal(after.untracked.length, 0);
  assert.equal(fs.readFileSync(path.join(repoDir, 't.txt'), 'utf8'), 'v1\n');
  assert.ok(!fs.existsSync(path.join(repoDir, 'u.txt')));
});

test('stashChanges/stashList/stashShow/stashApply/stashDrop work end-to-end', async (t) => {
  const repoDir = createTempDir(t, 'stash');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 's.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 's.txt');
  await git(repoDir, 'commit', '-m', 'base');

  fs.writeFileSync(path.join(repoDir, 's.txt'), 'v2\n', 'utf8');
  const stashRes = await gitChangesManager.stashChanges(repoDir, null, 'm1');
  assert.equal(stashRes.error, null);

  const list1 = await gitChangesManager.stashList(repoDir);
  assert.equal(list1.error, null);
  assert.ok(list1.stashes.length >= 1);
  const ref = list1.stashes[0].ref;

  const show = await gitChangesManager.stashShow(repoDir, ref);
  assert.equal(show.error, null);
  assert.ok(show.diff.includes('s.txt'));

  const apply = await gitChangesManager.stashApply(repoDir, ref);
  assert.equal(apply.error, null);
  assert.equal(fs.readFileSync(path.join(repoDir, 's.txt'), 'utf8'), 'v2\n');

  const list2 = await gitChangesManager.stashList(repoDir);
  assert.equal(list2.error, null);
  assert.ok(list2.stashes.some(s => s.ref === ref));

  const drop = await gitChangesManager.stashDrop(repoDir, ref);
  assert.equal(drop.error, null);

  const list3 = await gitChangesManager.stashList(repoDir);
  assert.equal(list3.error, null);
  assert.ok(!list3.stashes.some(s => s.ref === ref));
});

test('gitCommit supports multiline messages and gitCommitAmend updates message', async (t) => {
  const repoDir = createTempDir(t, 'commit-msg');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'c.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 'c.txt');
  const commitRes = await gitChangesManager.gitCommit(repoDir, 'sum\n\nbody');
  assert.equal(commitRes.error, null);

  const msg1 = await git(repoDir, 'log', '-1', '--pretty=%B');
  assert.ok(msg1.stdout.includes('sum'));
  assert.ok(msg1.stdout.includes('body'));

  fs.writeFileSync(path.join(repoDir, 'c.txt'), 'v2\n', 'utf8');
  await git(repoDir, 'add', 'c.txt');
  const amendRes = await gitChangesManager.gitCommitAmend(repoDir, 'newsum\n\nnewbody');
  assert.equal(amendRes.error, null);

  const msg2 = await git(repoDir, 'log', '-1', '--pretty=%B');
  assert.ok(msg2.stdout.includes('newsum'));
  assert.ok(msg2.stdout.includes('newbody'));
});

test('revertCommit creates a new commit and restores file content', async (t) => {
  const repoDir = createTempDir(t, 'revert');
  await initRepo(repoDir);

  const file = path.join(repoDir, 'r.txt');
  fs.writeFileSync(file, 'one\n', 'utf8');
  await git(repoDir, 'add', 'r.txt');
  await git(repoDir, 'commit', '-m', 'v1');

  fs.writeFileSync(file, 'two\n', 'utf8');
  await git(repoDir, 'commit', '-am', 'v2');
  const { stdout: v2Hash } = await git(repoDir, 'rev-parse', 'HEAD');

  const res = await gitChangesManager.revertCommit(repoDir, v2Hash);
  assert.equal(res.error, null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
});

test('revertCommit can revert merge commits (defaults to -m 1)', async (t) => {
  const repoDir = createTempDir(t, 'revert-merge');
  const baseBranch = await initRepo(repoDir);

  // Base commit on main
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'base');

  // Feature branch adds b.txt
  await git(repoDir, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'feature\n', 'utf8');
  await git(repoDir, 'add', 'b.txt');
  await git(repoDir, 'commit', '-m', 'feature adds b');

  // Main branch changes a.txt
  await git(repoDir, 'checkout', baseBranch);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'main\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'main changes a');

  // Merge feature into main (merge commit)
  await git(repoDir, 'merge', 'feature', '--no-ff', '-m', 'merge feature');
  const { stdout: mergeHash } = await git(repoDir, 'rev-parse', 'HEAD');
  assert.ok(fs.existsSync(path.join(repoDir, 'b.txt')));

  const res = await gitChangesManager.revertCommit(repoDir, mergeHash);
  assert.equal(res.error, null);

  // Reverting the merge with -m 1 should drop feature-only changes (b.txt),
  // while preserving mainline state (a.txt).
  assert.equal(fs.readFileSync(path.join(repoDir, 'a.txt'), 'utf8'), 'main\n');
  assert.ok(!fs.existsSync(path.join(repoDir, 'b.txt')));
});

test('loadCommitDiff works for initial commit (uses --root)', async (t) => {
  const repoDir = createTempDir(t, 'commit-diff');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'd.txt'), 'x\n', 'utf8');
  await git(repoDir, 'add', 'd.txt');
  await git(repoDir, 'commit', '-m', 'init');
  const { stdout: hash } = await git(repoDir, 'rev-parse', 'HEAD');

  const diff = await gitChangesManager.loadCommitDiff(repoDir, hash);
  assert.equal(diff.error, null);
  assert.ok(diff.diff.includes('d.txt'));
  assert.ok(diff.diff.includes('+++ b/'));
});
