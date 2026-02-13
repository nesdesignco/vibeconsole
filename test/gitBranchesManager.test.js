const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const gitBranchesManager = require('../src/main/gitBranchesManager');

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

async function git(cwd, ...args) {
  return runCommand('git', args, cwd);
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

test('loadBranches lists branches and marks current branch', async (t) => {
  const repoDir = createTempDir(t, 'branches');
  const base = await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'base');

  await git(repoDir, 'checkout', '-b', 'feature');
  await git(repoDir, 'checkout', base);

  const res = await gitBranchesManager.loadBranches(repoDir);
  assert.equal(res.error, null);
  assert.equal(res.currentBranch, base);
  assert.ok(res.branches.some(b => b.name === base && b.isCurrent));
  assert.ok(res.branches.some(b => b.name === 'feature'));
});

test('switchBranch blocks when working tree is dirty', async (t) => {
  const repoDir = createTempDir(t, 'switch-dirty');
  const base = await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'base');

  await git(repoDir, 'checkout', '-b', 'feature');
  await git(repoDir, 'checkout', base);

  // dirty working tree
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'dirty\n', 'utf8');

  const res = await gitBranchesManager.switchBranch(repoDir, 'feature');
  assert.equal(res.error, 'uncommitted_changes');
  assert.ok(Array.isArray(res.changes));
  assert.ok(res.changes.length >= 1);
});

test('createBranch can create without checkout and deleteBranch removes it', async (t) => {
  const repoDir = createTempDir(t, 'create-delete');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'base');

  const create = await gitBranchesManager.createBranch(repoDir, 'tmp-branch', false);
  assert.equal(create.error, null);

  const branches = await gitBranchesManager.loadBranches(repoDir);
  assert.ok(branches.branches.some(b => b.name === 'tmp-branch'));

  const del = await gitBranchesManager.deleteBranch(repoDir, 'tmp-branch', true);
  assert.equal(del.error, null);
  const branches2 = await gitBranchesManager.loadBranches(repoDir);
  assert.ok(!branches2.branches.some(b => b.name === 'tmp-branch'));
});

test('worktree add/list/remove works (with homedir patched for test sandbox)', async (t) => {
  const repoDir = createTempDir(t, 'worktrees');
  await initRepo(repoDir);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v1\n', 'utf8');
  await git(repoDir, 'add', 'a.txt');
  await git(repoDir, 'commit', '-m', 'base');

  // Create a branch that is not checked out in the main worktree
  await git(repoDir, 'branch', 'wt-branch');

  // Patch os.homedir to allow creating worktrees under /tmp in tests.
  const osMod = require('os');
  const origHome = osMod.homedir;
  const fakeHome = createTempDir(t, 'home');
  osMod.homedir = () => fakeHome;
  t.after(() => { osMod.homedir = origHome; });

  const worktreePath = path.join(fakeHome, 'wt1');
  const add = await gitBranchesManager.addWorktree(repoDir, worktreePath, 'wt-branch', false);
  assert.equal(add.error, null);
  assert.ok(fs.existsSync(worktreePath));

  const list = await gitBranchesManager.loadWorktrees(repoDir);
  assert.equal(list.error, null);
  const wantPath = fs.realpathSync(worktreePath);
  assert.ok(list.worktrees.some((wt) => {
    try {
      return fs.realpathSync(wt.path) === wantPath;
    } catch {
      return false;
    }
  }));

  // Verify the new worktree is usable as a git working tree.
  const inside = await git(worktreePath, 'rev-parse', '--is-inside-work-tree');
  assert.equal(inside.stdout, 'true');

  const rm = await gitBranchesManager.removeWorktree(repoDir, worktreePath, true);
  assert.equal(rm.error, null);
  assert.ok(!fs.existsSync(worktreePath));
});
