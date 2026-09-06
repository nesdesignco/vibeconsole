const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeFilename, filenameFromUrl, isPrivateAddress, assertPublicHttpUrl } = require('../src/main/droppedFiles');

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

test('isPrivateAddress flags loopback, private, link-local, and metadata ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.1.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1',
    '::ffff:127.0.0.1', '::ffff:192.168.1.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('assertPublicHttpUrl rejects internal targets without DNS', async () => {
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1/x.png'), /Blocked host/);
  await assert.rejects(assertPublicHttpUrl('http://localhost:8080/x.png'), /Blocked host/);
  await assert.rejects(assertPublicHttpUrl('http://foo.localhost/x.png'), /Blocked host/);
  await assert.rejects(assertPublicHttpUrl('http://printer.local/x.png'), /Blocked host/);
  await assert.rejects(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data'), /Blocked host/);
  await assert.rejects(assertPublicHttpUrl('http://0x7f000001/x.png'), /Blocked host/);
  await assert.rejects(assertPublicHttpUrl('http://[::1]/x.png'), /Blocked host/);
  await assert.rejects(assertPublicHttpUrl('ftp://example.com/x.png'), /Only http/);
  await assert.rejects(assertPublicHttpUrl('not a url'), /Invalid URL/);
});

test('filenameFromUrl uses URL basename and mime extension', () => {
  assert.equal(filenameFromUrl('https://x.test/images/cat.png', 'image/png'), 'cat.png');
  assert.equal(filenameFromUrl('https://x.test/images/cat', 'image/png'), 'cat.png');
  assert.equal(filenameFromUrl('https://x.test/images/cat.jpg?w=100', 'image/jpeg'), 'cat.jpg');
  assert.equal(filenameFromUrl('https://x.test/', 'image/webp'), 'download.webp');
  assert.equal(filenameFromUrl('not a url', ''), 'download');
});

test('full URLs reject mapped IPv6 private addresses after URL normalization', async () => {
  for (const host of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
    '::ffff:192.168.1.1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '::ffff:ac10:1']) {
    await assert.rejects(assertPublicHttpUrl(`http://[${host}]/image.png`), /Blocked host/, host);
    assert.equal(isPrivateAddress(host), true, host);
  }
  for (const host of ['::ffff:8.8.8.8', '::ffff:808:808', '2606:4700::1111']) {
    await assertPublicHttpUrl(`https://[${host}]/image.png`);
    assert.equal(isPrivateAddress(host), false, host);
  }
});

test('public-image redirect to mapped loopback is rejected before any local request', async t => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  const { loadModule } = require('./helpers/loadModule');
  const { IPC } = require('../src/shared/ipcChannels');
  let hits = 0;
  const server = http.createServer((_req, response) => { hits++; response.end('synthetic fixture'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const destination = `http://[::ffff:127.0.0.1]:${server.address().port}/image.png`;
  const requested = [], handlers = new Map();
  const dropped = loadModule('src/main/droppedFiles.js', {
    'node:dns': { promises: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } },
    electron: { net: { request: ({ url }) => {
      requested.push(url);
      const emitter = new EventEmitter(); let request;
      emitter.abort = () => request?.destroy();
      emitter.end = () => {
        if (url === 'https://fixture.example/image.png') { queueMicrotask(() => emitter.emit('redirect', 302, 'GET', destination)); return; }
        request = http.get(url, response => emitter.emit('response', response));
        request.on('error', error => emitter.emit('error', error));
      };
      return emitter;
    } } }
  });
  dropped.setupIPC({ handle: (channel, callback) => handlers.set(channel, callback) });
  const result = await handlers.get(IPC.DOWNLOAD_URL_TO_TEMP)(null, 'https://fixture.example/image.png');
  assert.equal(result.success, false); assert.match(result.error, /Blocked host/);
  assert.deepEqual(requested, ['https://fixture.example/image.png']); assert.equal(hits, 0);
});
