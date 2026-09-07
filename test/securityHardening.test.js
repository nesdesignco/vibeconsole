const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execFileSync } = require('node:child_process');

const {
  isPathWithinProjectContent,
  isRelativePathWithinProjectContent,
  isPathWithinDirectory
} = require('../src/shared/pathValidation');
const pathValidation = require('../src/shared/pathValidation');
const projectAccess = require('../src/main/projectAccess');
const gitBranchesManager = require('../src/main/gitBranchesManager');
const gitChangesManager = require('../src/main/gitChangesManager');
const { execFileGit, isValidBranchName } = require('../src/main/gitExecUtils');

function createTempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-${name}-`));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('project content validation blocks .git metadata paths', (t) => {
  const projectDir = createTempDir(t, 'path-guard');
  const srcDir = path.join(projectDir, 'src');
  const gitDir = path.join(projectDir, '.git');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });

  assert.equal(isPathWithinProjectContent(path.join(projectDir, 'src', 'index.js'), projectDir), true);
  assert.equal(isRelativePathWithinProjectContent(projectDir, 'src/index.js'), true);

  assert.equal(isPathWithinProjectContent(path.join(projectDir, '.git', 'config'), projectDir), false);
  assert.equal(isRelativePathWithinProjectContent(projectDir, '.git/config'), false);
});

test('directory containment rejects symlink escapes', (t) => {
  const projectDir = createTempDir(t, 'symlink-guard');
  const outsideDir = createTempDir(t, 'outside');
  const linkPath = path.join(projectDir, 'linked-outside');
  const escapedFile = path.join(linkPath, 'secret.txt');

  fs.symlinkSync(outsideDir, linkPath, 'dir');

  assert.equal(isPathWithinDirectory(escapedFile, projectDir), false);
  assert.equal(isPathWithinProjectContent(escapedFile, projectDir), false);
});

test('worktree guard only allows paths under home and not home itself', (t) => {
  const fakeHome = createTempDir(t, 'home-guard');
  const osMod = require('os');
  const originalHome = osMod.homedir;
  osMod.homedir = () => fakeHome;
  t.after(() => { osMod.homedir = originalHome; });

  assert.equal(gitBranchesManager.isAllowedWorktreePath(path.join(fakeHome, 'worktrees', 'feature-a')), true);
  assert.equal(gitBranchesManager.isAllowedWorktreePath(fakeHome), false);
  assert.equal(gitBranchesManager.isAllowedWorktreePath(path.join(path.dirname(fakeHome), 'outside')), false);
});

function createRepoWithCraftedHead(t, payloadScriptPath) {
  const dir = createTempDir(t, 'git-flag-injection');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

  // git refuses to *create* such a branch, but `branch --show-current` happily
  // echoes whatever HEAD points at. This is the attacker's entry point: shipping
  // a project as an archive with a hand-written .git/HEAD.
  const maliciousRef = `--upload-pack=${payloadScriptPath}`;
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${maliciousRef}\n`);
  return { repo, maliciousRef };
}

test('crafted .git/HEAD still yields a flag-like branch name (attack primitive exists)', (t) => {
  const marker = path.join(createTempDir(t, 'marker'), 'PWNED');
  const { repo, maliciousRef } = createRepoWithCraftedHead(t, '/nonexistent.sh');
  const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString().trim();
  assert.equal(current, maliciousRef);
  assert.equal(fs.existsSync(marker), false);
});

test('gitPull refuses a flag-injecting branch name and does not execute the payload', async (t) => {
  const markerDir = createTempDir(t, 'pull-marker');
  const marker = path.join(markerDir, 'PWNED');
  const script = path.join(markerDir, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  fs.chmodSync(script, 0o755);

  const { repo, maliciousRef } = createRepoWithCraftedHead(t, script);
  const result = await gitChangesManager.gitPull(repo, maliciousRef, true);

  assert.equal(result.error, 'Invalid branch name');
  assert.equal(fs.existsSync(marker), false, 'payload script must not run');
});

test('gitPush refuses a flag-injecting branch name', async (t) => {
  const markerDir = createTempDir(t, 'push-marker');
  const marker = path.join(markerDir, 'PWNED');
  const script = path.join(markerDir, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  fs.chmodSync(script, 0o755);

  const { repo, maliciousRef } = createRepoWithCraftedHead(t, script);
  const result = await gitChangesManager.gitPush(repo, maliciousRef, true);

  assert.equal(result.error, 'Invalid branch name');
  assert.equal(fs.existsSync(marker), false, 'payload script must not run');
});

test('isValidBranchName rejects flag-shaped refs and accepts ordinary ones', () => {
  assert.equal(isValidBranchName('--upload-pack=/tmp/evil.sh'), false);
  assert.equal(isValidBranchName('-u'), false);
  assert.equal(isValidBranchName('feature/add-thing'), true);
  assert.equal(isValidBranchName('release/1.2.3'), true);
});

test('execFileGit refuses git command-execution flags as a backstop', async (t) => {
  const repo = createTempDir(t, 'backstop');
  await assert.rejects(
    () => execFileGit(['pull', 'origin', '--upload-pack=/tmp/evil.sh'], repo),
    (err) => /Refused unsafe git argument/.test(err.error)
  );
  await assert.rejects(
    () => execFileGit(['push', '--receive-pack=/tmp/evil.sh'], repo),
    (err) => /Refused unsafe git argument/.test(err.error)
  );
});

test('path containment refuses a project root the main process never issued', (t) => {
  const projectDir = createTempDir(t, 'unregistered');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  const inside = path.join(projectDir, 'src', 'index.js');

  // The pure validator is happy: the file really is inside the given base.
  assert.equal(pathValidation.isPathWithinProjectContent(inside, projectDir), true);

  // The guarded one is not, because nothing ever registered this root. Without
  // that check a caller could supply its own base and satisfy containment
  // against any directory on disk.
  assert.equal(projectAccess.isPathWithinProjectContent(inside, projectDir), false);
  assert.equal(projectAccess.isKnownProjectRoot(projectDir), false);

  projectAccess.registerProjectRoot(projectDir);
  assert.equal(projectAccess.isKnownProjectRoot(projectDir), true);
  assert.equal(projectAccess.isPathWithinProjectContent(inside, projectDir), true);
});

test('an attacker-chosen base cannot reach outside a registered project', (t) => {
  const projectDir = createTempDir(t, 'registered');
  const outsideDir = createTempDir(t, 'victim');
  const secret = path.join(outsideDir, 'id_rsa');
  fs.writeFileSync(secret, 'private', 'utf8');
  projectAccess.registerProjectRoot(projectDir);

  // The exact shape the handlers accept: base and target from the same message.
  assert.equal(projectAccess.isPathWithinProjectContent(secret, '/'), false);
  assert.equal(projectAccess.isPathWithinProjectContent(secret, outsideDir), false);
  assert.equal(projectAccess.isPathWithinProjectContent(secret, projectDir), false);
  assert.equal(projectAccess.isRelativePathWithinProjectContent('/', 'Users/x/.ssh/id_rsa'), false);
});

test('registering a root normalizes it, and rejects unusable input', (t) => {
  const projectDir = createTempDir(t, 'normalize');
  const messy = path.join(projectDir, 'src', '..');

  projectAccess.registerProjectRoot(messy);
  assert.equal(projectAccess.isKnownProjectRoot(projectDir), true);

  assert.equal(projectAccess.registerProjectRoot(''), null);
  assert.equal(projectAccess.registerProjectRoot(null), null);
  assert.equal(projectAccess.isKnownProjectRoot(null), false);
});
