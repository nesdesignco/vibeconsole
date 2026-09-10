const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadModule, createElements } = require('./helpers/loadModule');
const manager = require('../src/main/gitChangesManager');
const { registerProjectRoot } = require('../src/main/projectAccess');
const { IPC } = require('../src/shared/ipcChannels');

test('Git file right-click delegates nested targets once without opening the diff', () => {
  const listeners = new Map(), menus = [];
  class Element {
    closest(selector) { return selector === '.git-change-item' ? this.item : null; }
  }
  const { bindDelegatedEvents } = loadModule('src/renderer/githubPanel/delegatedEvents.js', {}, { Element });
  const content = { addEventListener: (name, listener) => { assert.ok(!listeners.has(name)); listeners.set(name, listener); } };
  const handlers = { onFileContextMenu: (...args) => menus.push(args) };
  bindDelegatedEvents(content, handlers); bindDelegatedEvents(content, handlers);
  const target = new Element(); target.item = { dataset: { path: 'clips/arrival v2.mp4' } };
  let prevented = 0, stopped = 0;
  const event = { target, clientX: 300, clientY: 450, preventDefault: () => prevented++, stopPropagation: () => stopped++ };
  listeners.get('contextmenu')(event);
  assert.deepEqual(menus, [[300, 450, 'clips/arrival v2.mp4']]);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  target.item = null; listeners.get('contextmenu')(event);
  assert.equal(menus.length, 1);
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
} });
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-git-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  registerProjectRoot(dir);
  git(dir, 'init', '-qb', 'main'); git(dir, 'config', 'user.name', 'Review'); git(dir, 'config', 'user.email', 'review@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'before\n'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-qm', 'base');
  return dir;
}
function conflict(t) {
  const dir = repo(t);
  git(dir, 'checkout', '-qb', 'other'); fs.writeFileSync(path.join(dir, 'a.txt'), 'theirs \t\r\n'); git(dir, 'commit', '-qam', 'theirs');
  git(dir, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), 'ours   \n\n'); git(dir, 'commit', '-qam', 'ours');
  assert.throws(() => git(dir, 'merge', 'other'));
  return dir;
}
function modalFixture(project, invoke) {
  const element = createElements(), changed = [], requests = [];
  let active = project;
  const modal = loadModule('src/renderer/gitConflictResolver.js', {
    './state': { getProjectPath: () => active, onProjectChange: cb => changed.push(cb) },
    './electronBridge': { pathApi: path, ipcRenderer: { invoke: (channel, data) => { requests.push({ channel, data }); return invoke(channel, data); } } }
  }, { document: { getElementById: element } });
  modal.init({ showToast() {}, loadChanges() {} });
  return { modal, element, requests, switchProject: value => { active = value; changed.forEach(cb => cb(value)); },
    resolve: () => element('.conflict-mark-resolved-btn').listeners.get('click')() };
}

test('project switch closes conflict modal and never writes to the other repository', async t => {
  const a = conflict(t), b = repo(t);
  const f = modalFixture(a, (channel, data) => channel === IPC.LOAD_GIT_CONFLICT
    ? manager.loadGitConflict(data.projectPath, data.filePath)
    : manager.resolveGitConflict(data.projectPath, data.filePath, data.resolvedContent));
  await f.modal.showConflictModal('a.txt');
  f.element('.conflict-resolved-input').value = 'resolution intended for A\n';
  f.switchProject(b); await f.resolve();
  assert.equal(f.element('git-conflict-modal').classList.contains('visible'), false);
  assert.equal(f.requests.filter(r => r.channel === IPC.RESOLVE_GIT_CONFLICT).length, 0);
  assert.equal(fs.readFileSync(path.join(b, 'a.txt'), 'utf8'), 'before\n');
  assert.equal(git(b, 'show', ':a.txt'), 'before\n');
  assert.ok(git(a, 'ls-files', '-u'));
});

test('late conflict load cannot populate a new project modal', async () => {
  const pending = [];
  const f = modalFixture('/a', () => new Promise(resolve => pending.push(resolve)));
  const a = f.modal.showConflictModal('a.txt'); f.switchProject('/b');
  const b = f.modal.showConflictModal('b.txt');
  pending[1]({ filePath: 'b.txt', ours: 'B', current: 'B' }); await b;
  pending[0]({ filePath: 'a.txt', ours: 'A', current: 'A' }); await a;
  assert.equal(f.element('.conflict-resolved-input').value, 'B');
  assert.equal(f.element('.conflict-mark-resolved-btn').disabled, false);
});

test('conflict reads and resolution preserve exact stage content; stale resolution is rejected', async t => {
  const dir = conflict(t), details = await manager.loadGitConflict(dir, 'a.txt');
  assert.equal(details.error, null);
  for (const [key, stage] of [['base', 1], ['ours', 2], ['theirs', 3]]) assert.equal(details[key], git(dir, 'show', `:${stage}:a.txt`));
  assert.equal((await manager.resolveGitConflict(dir, 'a.txt', details.ours)).error, null);
  assert.equal(git(dir, 'show', ':a.txt'), details.ours);
  assert.match((await manager.resolveGitConflict(dir, 'a.txt', 'stale overwrite')).error, /no longer in conflict/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), details.ours);
});

for (const content of ['after   \n', 'after\t\r\n', 'after\n\n', 'after   ']) {
  test(`hunk staging and unstaging preserve exact bytes ${JSON.stringify(content)}`, async t => {
    const dir = repo(t); fs.writeFileSync(path.join(dir, 'a.txt'), content);
    const diff = await manager.loadDiff(dir, 'a.txt', 'unstaged'); assert.equal(diff.error, null);
    const patch = manager.extractHunkPatches(diff.diff)[0].patch;
    assert.equal((await manager.applyGitHunk(dir, 'a.txt', 'unstaged', 'stage', patch)).error, null);
    assert.equal(git(dir, 'show', ':a.txt'), content);
    const staged = await manager.loadDiff(dir, 'a.txt', 'staged');
    assert.equal((await manager.applyGitHunk(dir, 'a.txt', 'staged', 'unstage', manager.extractHunkPatches(staged.diff)[0].patch)).error, null);
    assert.equal(git(dir, 'show', ':a.txt'), 'before\n');
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), content);
  });
}
