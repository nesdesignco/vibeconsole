const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getProjectContextStatus } = require('../src/main/projectContext');
const {
  CORE_CONTEXT_FILES,
  formatFileStatus,
  buildProjectContextPrompt
} = require('../src/shared/projectContextPrompt');

function createProject(t) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-project-context-'));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  return projectPath;
}

test('context status reports every missing canonical file', (t) => {
  const projectPath = createProject(t);
  fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Claude\n', 'utf8');

  assert.deepEqual(getProjectContextStatus(projectPath), {
    success: true,
    files: {
      structureJson: false,
      projectNotesMd: false,
      tasksJson: false,
      agentsMd: false,
      claudeMd: true
    },
    missingCoreFiles: CORE_CONTEXT_FILES,
    mode: 'initialize'
  });
});

test('context status reports audit mode when the canonical package exists', (t) => {
  const projectPath = createProject(t);
  fs.writeFileSync(path.join(projectPath, 'STRUCTURE.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(projectPath, 'PROJECT_NOTES.md'), '# Notes\n', 'utf8');
  fs.writeFileSync(path.join(projectPath, 'tasks.json'), '[]\n', 'utf8');
  fs.writeFileSync(path.join(projectPath, 'AGENTS.md'), '# Instructions\n', 'utf8');

  assert.deepEqual(getProjectContextStatus(projectPath), {
    success: true,
    files: {
      structureJson: true,
      projectNotesMd: true,
      tasksJson: true,
      agentsMd: true,
      claudeMd: false
    },
    missingCoreFiles: [],
    mode: 'audit'
  });
});

test('context status rejects invalid and non-directory paths', (t) => {
  const projectPath = createProject(t);
  const filePath = path.join(projectPath, 'not-a-project.txt');
  fs.writeFileSync(filePath, '', 'utf8');

  assert.equal(getProjectContextStatus('relative/project').success, false);
  assert.equal(getProjectContextStatus(filePath).success, false);
});

test('file-status summary includes canonical and instruction files', () => {
  const summary = formatFileStatus({
    files: {
      structureJson: true,
      projectNotesMd: false,
      tasksJson: false,
      agentsMd: true,
      claudeMd: false
    }
  });

  assert.match(summary, /STRUCTURE\.json: present/);
  assert.match(summary, /PROJECT_NOTES\.md: missing/);
  assert.match(summary, /tasks\.json: missing/);
  assert.match(summary, /AGENTS\.md: present/);
  assert.match(summary, /CLAUDE\.md: missing/);
});

test('initialize prompt targets the complete context package and requires approval', () => {
  const prompt = buildProjectContextPrompt({
    mode: 'initialize',
    files: { claudeMd: true }
  });

  assert.match(prompt, /STRUCTURE\.json: a factual, machine-readable map/);
  assert.match(prompt, /PROJECT_NOTES\.md: durable project knowledge/);
  assert.match(prompt, /tasks\.json: the agreed project-task tracker/);
  assert.match(prompt, /If neither instruction file exists, report that fact but do not create one/);
  assert.match(prompt, /No files have been changed\. Approve this proposal\?/);
  assert.match(prompt, /Only after explicit approval/);
  assert.doesNotMatch(prompt, /[çğıöşüÇĞİÖŞÜ]/);
});

test('audit prompt preserves existing content and requests focused diffs', () => {
  const prompt = buildProjectContextPrompt({
    mode: 'audit',
    files: {
      structureJson: true,
      projectNotesMd: true,
      tasksJson: true,
      agentsMd: true
    }
  });

  assert.match(prompt, /audit and refresh the existing VibeConsole project context/);
  assert.match(prompt, /Never replace an existing context or instruction file wholesale/);
  assert.match(prompt, /show a focused unified diff/);
  assert.match(prompt, /Preserve every existing task/);
});
