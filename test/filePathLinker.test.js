const test = require('node:test');
const assert = require('node:assert/strict');

const { findFilePathMatches, getFilePathLinks } = require('../src/renderer/filePathLinker');
const { attachClickLinkFallback } = require('../src/renderer/urlLinker');
const { createTerminalLinkHandler } = require('../src/renderer/terminalManager');

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

test('linkifies the Codex Viewed Image paths and common image/video formats', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg', 'mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi', 'ogv', 'mpg', 'mpeg']) {
    const file = `site/scrollcraft/builds/continuity-v3/production/watch-outdoor.${ext}`;
    assert.deepEqual(paths(`  └ ${file}`), [file]);
    assert.deepEqual(paths(`https://example.com/${file}`), []);
  }
  assert.deepEqual(paths('/project/preview.PNG'), ['/project/preview.PNG']);
});

function terminalLines(text, cols = 24) {
  const cells = [];
  for (const char of text) {
    const width = char === '界' ? 2 : 1;
    cells.push({ getChars: () => char, getWidth: () => width });
    if (width === 2) cells.push({ getChars: () => '', getWidth: () => 0 });
  }
  const lines = [];
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    lines.push({ length: row.length, isWrapped: i > 0, getCell: col => row[col],
      translateToString: () => row.map(c => c.getChars()).join('') });
  }
  return { cols, rows: 10, buffer: { active: { length: lines.length, viewportY: 0, getLine: row => lines[row] } } };
}

test('wrapped image links use inclusive cell coordinates, including a wide-character prefix', () => {
  const file = 'site/scrollcraft/production/watch-outdoor.png';
  const terminal = terminalLines(`界 ${file} done`);
  const activated = [];
  for (const row of [1, 2]) {
    const [link] = getFilePathLinks(terminal, row, (...args) => activated.push(args));
    assert.equal(link.text, file);
    assert.deepEqual(link.range.start, { x: 4, y: 1 });
    assert.deepEqual(link.range.end, { x: (3 + file.length - 1) % 24 + 1, y: 2 });
    link.activate();
  }
  assert.deepEqual(activated, [[file, undefined, undefined], [file, undefined, undefined]]);
});

test('file click fallback survives redraw, deduplicates native activation and preserves selection gestures', async () => {
  const file = 'site/production/preview.png', opened = [], listeners = new Map();
  const terminal = terminalLines(file + ' ', 40);
  const line = terminal.buffer.active.getLine(0);
  const element = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 100 }) })
  };
  const handler = createTerminalLinkHandler({ send() {} }, path => opened.push(path));
  attachClickLinkFallback(terminal, element, handler);
  async function click({ shiftKey = false, drag = false, native = false, redraw = false, col = 5 } = {}) {
    terminal.buffer.active.getLine = row => row === 0 ? line : undefined;
    listeners.get('mousedown')({ button: 0, clientX: col * 10 + 1, clientY: 1 });
    listeners.get('mouseup')({ button: 0, clientX: col * 10 + (drag ? 20 : 1), clientY: 1, shiftKey });
    if (native) handler.activateFile(file);
    if (redraw) terminal.buffer.active.getLine = () => undefined;
    await new Promise(resolve => setTimeout(resolve, 45));
  }
  await click({ redraw: true });
  assert.deepEqual(opened, [file]);
  await new Promise(resolve => setTimeout(resolve, 510));
  await click({ native: true });
  assert.deepEqual(opened, [file, file]);
  await new Promise(resolve => setTimeout(resolve, 510));
  await click({ shiftKey: true }); await click({ drag: true }); await click({ col: file.length });
  assert.deepEqual(opened, [file, file]);
});
