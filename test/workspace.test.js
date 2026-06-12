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
