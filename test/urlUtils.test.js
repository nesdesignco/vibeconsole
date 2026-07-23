const test = require('node:test');
const assert = require('node:assert/strict');

const { BARE_URL_REGEX, findUrlAtColumn, normalizeTerminalUrl, stripTrailingJunk } = require('../src/shared/urlUtils');

function matches(text) {
  BARE_URL_REGEX.lastIndex = 0;
  const found = [];
  let match;
  while ((match = BARE_URL_REGEX.exec(text)) !== null) {
    found.push(match[0]);
  }
  return found;
}

test('bare URL regex matches protocol-less web URLs', () => {
  assert.deepEqual(matches('Canlı: form-drive.vercel.app yayında'), ['form-drive.vercel.app']);
  assert.deepEqual(matches('Kaynak kod: github.com/nesdesignco/FormDrive'), ['github.com/nesdesignco/FormDrive']);
  assert.deepEqual(matches('Pages: nesdesignco.github.io/FormDrive/'), ['nesdesignco.github.io/FormDrive/']);
  assert.deepEqual(matches('bkz www.google.com ve www.example.co.uk/path'), ['www.google.com', 'www.example.co.uk/path']);
  assert.deepEqual(matches('dev server localhost:3000/admin çalışıyor'), ['localhost:3000/admin']);
});

test('bare URL regex ignores file names, paths, emails and versions', () => {
  assert.deepEqual(matches('package.json ve index.d.ts dosyaları'), []);
  assert.deepEqual(matches('chart.min.js yüklendi, deploy.sh çalıştı'), []);
  assert.deepEqual(matches('src/main/index.js:42 hatası'), []);
  assert.deepEqual(matches('mail: contact@eneskaymaz.com'), []);
  assert.deepEqual(matches('sürüm v1.2.3 yayınlandı e.g. test'), []);
  assert.deepEqual(matches('localhost üzerinde (portsuz)'), []);
});

test('bare URL regex does not re-match hosts inside full URLs', () => {
  assert.deepEqual(matches('adres https://github.com/a/b dedik'), []);
  assert.deepEqual(matches('adres https://www.example.com dedik'), []);
});

test('stripTrailingJunk removes prose punctuation and unbalanced brackets', () => {
  assert.equal(stripTrailingJunk('https://x.com/y).'), 'https://x.com/y');
  assert.equal(stripTrailingJunk('https://x.com/y,'), 'https://x.com/y');
  assert.equal(stripTrailingJunk('https://en.wikipedia.org/wiki/Foo_(bar)'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(stripTrailingJunk('vercel.app]'), 'vercel.app');
});

test('normalizeTerminalUrl adds missing protocols and keeps existing ones', () => {
  assert.equal(normalizeTerminalUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeTerminalUrl('form-drive.vercel.app'), 'https://form-drive.vercel.app');
  assert.equal(normalizeTerminalUrl('www.google.com'), 'https://www.google.com');
  assert.equal(normalizeTerminalUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeTerminalUrl('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(normalizeTerminalUrl('https://x.com/y).'), 'https://x.com/y');
});

test('findUrlAtColumn resolves the URL under a column (mouse-capture hit test)', () => {
  const line = 'bkz (https://example.com/x) ve form-drive.vercel.app tamam';
  assert.equal(findUrlAtColumn(line, 10), 'https://example.com/x');   // URL içi
  assert.equal(findUrlAtColumn(line, 35), 'form-drive.vercel.app');   // çıplak domain içi
  assert.equal(findUrlAtColumn(line, 0), null);                       // link dışı
  assert.equal(findUrlAtColumn(line, 55), null);                      // link sonrası
  assert.equal(findUrlAtColumn('T6 localhost:3000 ', 8), 'localhost:3000');
});

test('normalizeTerminalUrl rejects unusable input', () => {
  assert.equal(normalizeTerminalUrl(''), null);
  assert.equal(normalizeTerminalUrl('   '), null);
  assert.equal(normalizeTerminalUrl(')..'), null);
  assert.equal(normalizeTerminalUrl(null), null);
  assert.equal(normalizeTerminalUrl(42), null);
});
