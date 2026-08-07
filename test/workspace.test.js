const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect ~/.frame to a temp dir before the module computes its paths.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-workspace-test-'));
const realHomedir = os.homedir;
os.homedir = () => tempHome;

const workspace = require('../src/main/workspace');
workspace.init({}, null);

test.after(() => {
  os.homedir = realHomedir;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('init creates default workspace file', () => {
  const file = path.join(tempHome, '.frame', 'workspaces.json');
  assert.ok(fs.existsSync(file));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.activeWorkspace, 'default');
  assert.deepEqual(data.workspaces.default.projects, []);
});

test('addProject adds project and rejects duplicates', () => {
  assert.equal(workspace.addProject('/tmp/proj-a', 'Proj A'), true);
  assert.equal(workspace.addProject('/tmp/proj-a', 'Proj A'), false);

  const projects = workspace.getProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].path, '/tmp/proj-a');
  assert.equal(projects[0].name, 'Proj A');
  assert.equal(projects[0].lastOpenedAt, null);
});

test('addProject derives name from path when omitted', () => {
  workspace.addProject('/tmp/proj-b');
  const project = workspace.getProjects().find(p => p.path === '/tmp/proj-b');
  assert.equal(project.name, 'proj-b');
});

test('updateProjectLastOpened sets timestamp', () => {
  workspace.updateProjectLastOpened('/tmp/proj-a');
  const project = workspace.getProjects().find(p => p.path === '/tmp/proj-a');
  assert.ok(project.lastOpenedAt);
  assert.ok(!Number.isNaN(Date.parse(project.lastOpenedAt)));
});

test('removeProject removes only the given project', () => {
  workspace.removeProject('/tmp/proj-a');
  const paths = workspace.getProjects().map(p => p.path);
  assert.deepEqual(paths, ['/tmp/proj-b']);
});

test('changes are persisted to disk', () => {
  const file = path.join(tempHome, '.frame', 'workspaces.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const paths = data.workspaces.default.projects.map(p => p.path);
  assert.deepEqual(paths, ['/tmp/proj-b']);
});

/**
 * The module caches the parsed workspace for the process lifetime, so a test
 * that rewrites the file on disk needs a fresh instance rather than a
 * test-only reset hook in production code.
 */
function reloadWorkspace() {
  const modulePath = require.resolve('../src/main/workspace');
  delete require.cache[modulePath];
  const fresh = require('../src/main/workspace');
  fresh.init({}, null);
  return fresh;
}

test('a structurally broken workspace file is repaired instead of throwing', () => {
  const file = path.join(tempHome, '.frame', 'workspaces.json');
  const original = fs.readFileSync(file, 'utf8');

  // Valid JSON, but activeWorkspace points at a workspace that is not there.
  fs.writeFileSync(file, JSON.stringify({
    version: '1.1',
    activeWorkspace: 'missing',
    workspaces: { other: { name: 'Other', projects: [{ path: '/p/one', name: 'one' }] } }
  }), 'utf8');

  const ws = reloadWorkspace();

  // Previously this threw a TypeError out of a plain ipcMain.on handler.
  assert.doesNotThrow(() => ws.addProject('/p/two', 'two'));
  assert.deepEqual(ws.getProjects().map(p => p.path), ['/p/one', '/p/two'],
    'existing projects must survive the repair');

  fs.writeFileSync(file, original, 'utf8');
});

test('a workspace entry missing its projects array is repaired', () => {
  const file = path.join(tempHome, '.frame', 'workspaces.json');
  const original = fs.readFileSync(file, 'utf8');

  fs.writeFileSync(file, JSON.stringify({
    version: '1.1',
    activeWorkspace: 'default',
    workspaces: { default: { name: 'Default' } }
  }), 'utf8');

  const ws = reloadWorkspace();

  assert.doesNotThrow(() => ws.removeProject('/nope'));
  assert.deepEqual(ws.getProjects(), []);

  fs.writeFileSync(file, original, 'utf8');
});
