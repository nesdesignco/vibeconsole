const test = require('node:test');
const assert = require('node:assert/strict');

const { findFilePathMatches } = require('../src/renderer/filePathLinker');

function paths(text) {
  return findFilePathMatches(text).map(m => m.path);
}

test('linkifies bare relative paths as printed by linters and test runners', () => {
  assert.deepEqual(paths('src/renderer/editor.js:42'), ['src/renderer/editor.js']);
  assert.deepEqual(paths('test/smoke.js'), ['test/smoke.js']);
  assert.deepEqual(paths('  at packages/core/lib/index.ts:10:5'), ['packages/core/lib/index.ts']);
});

test('still linkifies explicit-relative and absolute paths', () => {
  assert.deepEqual(paths('./src/foo.js:1'), ['./src/foo.js']);
  assert.deepEqual(paths('../lib/util.js'), ['../lib/util.js']);
  assert.deepEqual(paths('/Users/x/a/b.js:3'), ['/Users/x/a/b.js']);
  assert.deepEqual(paths('/b.js'), ['/b.js']);
});

test('captures line and column suffixes', () => {
  const [match] = findFilePathMatches('src/renderer/editor.js:42:7');
  assert.equal(match.path, 'src/renderer/editor.js');
  assert.equal(match.line, 42);
  assert.equal(match.col, 7);

  const [lineOnly] = findFilePathMatches('src/a.js:9');
  assert.equal(lineOnly.line, 9);
  assert.equal(lineOnly.col, undefined);
});

test('leaves URLs and bare domains to the URL linker', () => {
  assert.deepEqual(paths('https://example.com/path/file.js'), []);
  assert.deepEqual(paths('http://a.co/b.js'), []);
  assert.deepEqual(paths('example.com/app.js'), []);
  assert.deepEqual(paths('form-drive.vercel.app/main.js'), []);
});

test('requires a slash so single file names are not linkified', () => {
  assert.deepEqual(paths('package.json'), []);
  assert.deepEqual(paths('README.md'), []);
});

test('does not match unknown extensions', () => {
  assert.deepEqual(paths('src/renderer.js.map'), []);
  assert.deepEqual(paths('build/output.bin'), []);
});

test('finds multiple paths on one line and reports their positions', () => {
  const text = 'moved src/a.js to lib/b.ts';
  const matches = findFilePathMatches(text);
  assert.deepEqual(matches.map(m => m.path), ['src/a.js', 'lib/b.ts']);
  assert.equal(text.slice(matches[0].index, matches[0].index + matches[0].length), 'src/a.js');
  assert.equal(text.slice(matches[1].index, matches[1].index + matches[1].length), 'lib/b.ts');
});

test('handles paths inside quotes and parentheses', () => {
  assert.deepEqual(paths("'src/a.js'"), ['src/a.js']);
  assert.deepEqual(paths('(src/a.js:3)'), ['src/a.js']);
});
