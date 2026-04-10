const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isPathWithinProjectContent,
  isRelativePathWithinProjectContent,
  isPathWithinDirectory
} = require('../src/shared/pathValidation');
const gitBranchesManager = require('../src/main/gitBranchesManager');

function createTempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-${name}-`));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function loadPluginsManagerWithHome(fakeHome) {
  const osMod = require('os');
  const modulePath = require.resolve('../src/main/pluginsManager');
  const originalHome = osMod.homedir;

  osMod.homedir = () => fakeHome;
  delete require.cache[modulePath];
  const manager = require('../src/main/pluginsManager');

  return {
    manager,
    restore() {
      delete require.cache[modulePath];
      osMod.homedir = originalHome;
    }
  };
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

test('plugins manager rejects invalid or uninstalled plugin ids', (t) => {
  const fakeHome = createTempDir(t, 'plugins-home');
  const claudeDir = path.join(fakeHome, '.claude');
  const pluginsDir = path.join(claudeDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'safe-plugin@claude-plugins-official': [{ installedAt: '2026-03-19T00:00:00Z' }]
    }
  }, null, 2), 'utf8');

  const { manager, restore } = loadPluginsManagerWithHome(fakeHome);
  t.after(restore);

  const invalid = manager.togglePlugin('../evil');
  assert.equal(invalid.success, false);
  assert.equal(invalid.error, 'Invalid plugin ID');

  const missing = manager.togglePlugin('missing@claude-plugins-official');
  assert.equal(missing.success, false);
  assert.equal(missing.error, 'Plugin is not installed');

  const valid = manager.togglePlugin('safe-plugin@claude-plugins-official');
  assert.equal(valid.success, true);

  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.enabledPlugins['safe-plugin@claude-plugins-official'], true);
});

test('plugins manager only trusts official marketplace remotes', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-plugin-remote-'));
  const { manager, restore } = loadPluginsManagerWithHome(fakeHome);
  try {
    assert.equal(manager.isTrustedMarketplaceRemote('https://github.com/anthropics/claude-plugins-official.git'), true);
    assert.equal(manager.isTrustedMarketplaceRemote('git@github.com:anthropics/claude-plugins-official.git'), true);
    assert.equal(manager.isTrustedMarketplaceRemote('https://github.com/attacker/claude-plugins-official.git'), false);
  } finally {
    restore();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
