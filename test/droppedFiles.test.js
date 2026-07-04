const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeFilename, filenameFromUrl } = require('../src/main/droppedFiles');

test('sanitizeFilename strips directories and traversal', () => {
  assert.equal(sanitizeFilename('/etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('../../secret.txt'), 'secret.txt');
  assert.equal(sanitizeFilename('..'), 'dropped-file');
  assert.equal(sanitizeFilename(''), 'dropped-file');
  assert.equal(sanitizeFilename(null), 'dropped-file');
});

test('sanitizeFilename replaces unsafe characters but keeps extension', () => {
  assert.equal(sanitizeFilename('shot 2026:01*02?.png'), 'shot 2026_01_02_.png');
  assert.equal(sanitizeFilename('a<b>c|d.jpeg'), 'a_b_c_d.jpeg');
  assert.equal(sanitizeFilename('img\u0000\u001f.png'), 'img__.png');
});

test('sanitizeFilename bounds very long names', () => {
  const long = 'x'.repeat(300) + '.png';
  const result = sanitizeFilename(long);
  assert.ok(result.length <= 128);
  assert.ok(result.endsWith('.png'));
});

test('filenameFromUrl uses URL basename and mime extension', () => {
  assert.equal(filenameFromUrl('https://x.test/images/cat.png', 'image/png'), 'cat.png');
  assert.equal(filenameFromUrl('https://x.test/images/cat', 'image/png'), 'cat.png');
  assert.equal(filenameFromUrl('https://x.test/images/cat.jpg?w=100', 'image/jpeg'), 'cat.jpg');
  assert.equal(filenameFromUrl('https://x.test/', 'image/webp'), 'download.webp');
  assert.equal(filenameFromUrl('not a url', ''), 'download');
});
