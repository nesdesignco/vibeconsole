const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getFileTree } = require('../src/main/fileTree');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-filetree-test-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'README.md'), '');
  fs.writeFileSync(path.join(root, '.env'), '');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), '');
  return root;
}

test('getFileTree lists files and directories with metadata', () => {
  const root = makeFixture();
  try {
    const tree = getFileTree(root);
    const names = tree.map(f => f.name);

    assert.ok(names.includes('src'));
    assert.ok(names.includes('README.md'));
    assert.ok(names.includes('.env'), 'dotfiles should be visible');

    const src = tree.find(f => f.name === 'src');
    assert.equal(src.isDirectory, true);
    assert.deepEqual(src.children.map(c => c.name), ['index.js']);
    assert.equal(src.children[0].path, path.join(root, 'src', 'index.js'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getFileTree excludes node_modules and .git', () => {
  const root = makeFixture();
  try {
    const names = getFileTree(root).map(f => f.name);
    assert.ok(!names.includes('node_modules'));
    assert.ok(!names.includes('.git'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getFileTree sorts directories before files', () => {
  const root = makeFixture();
  try {
    const tree = getFileTree(root);
    const firstFileIdx = tree.findIndex(f => !f.isDirectory);
    const lastDirIdx = tree.map(f => f.isDirectory).lastIndexOf(true);
    assert.ok(lastDirIdx < firstFileIdx);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getFileTree respects maxDepth', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-filetree-depth-'));
  try {
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    const tree = getFileTree(root, 2);
    const a = tree.find(f => f.name === 'a');
    const b = a.children.find(f => f.name === 'b');
    assert.deepEqual(b.children, [], 'depth 2 should not descend into c');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getFileTree handles symlink cycles without hanging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-filetree-loop-'));
  try {
    const dir = path.join(root, 'dir');
    fs.mkdirSync(dir);
    fs.symlinkSync(root, path.join(dir, 'loop'), 'dir');
    const tree = getFileTree(root, 10);
    assert.ok(Array.isArray(tree));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getFileTree returns empty array for missing directory', () => {
  assert.deepEqual(getFileTree('/nonexistent-vibe-test-path'), []);
});
