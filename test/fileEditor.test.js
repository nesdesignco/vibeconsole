const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const editor = require('../src/main/fileEditor');
const { registerProjectRoot } = require('../src/main/projectAccess');
const { IPC } = require('../src/shared/ipcChannels');
const { loadModule } = require('./helpers/loadModule');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-editor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  registerProjectRoot(dir);
  return dir;
}

for (const mode of [0o600, 0o755]) {
  test(`atomic editor save preserves ${mode.toString(8)} permissions`, async t => {
    const dir = fixture(t), file = path.join(dir, 'file'); fs.writeFileSync(file, 'before'); fs.chmodSync(file, mode);
    assert.equal((await editor.writeFile(file, 'after', dir)).success, true);
    assert.equal(fs.statSync(file).mode & 0o777, mode);
    assert.equal(fs.readFileSync(file, 'utf8'), 'after');
    assert.deepEqual(fs.readdirSync(dir), ['file']);
  });
}

test('saving through symlinks preserves links and serializes writes to their shared target', async t => {
  const dir = fixture(t), target = path.join(dir, 'target'), link = path.join(dir, 'link');
  fs.writeFileSync(target, 'original'); fs.symlinkSync(target, link);
  const saves = Array.from({ length: 12 }, (_, i) => editor.writeFile(i % 2 ? link : target, `save ${i}`, dir));
  assert.ok((await Promise.all(saves)).every(r => r.success));
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'save 11');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link', 'target']);
});

test('broken and outside-project symlink saves fail without replacing links or targets', async t => {
  const dir = fixture(t), outside = fixture(t), target = path.join(outside, 'target');
  fs.writeFileSync(target, 'original');
  for (const [name, dest] of [['outside', target], ['broken', path.join(dir, 'missing')]]) {
    const link = path.join(dir, name); fs.symlinkSync(dest, link);
    assert.equal((await editor.writeFile(link, 'after', dir)).success, false);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(dir, 'missing')), false);
});

test('failed atomic replacement preserves original contents and cleans temporary files', async t => {
  const dir = fixture(t), file = path.join(dir, 'file'); fs.writeFileSync(file, 'before');
  const failing = loadModule('src/main/fileEditor.js', { fs: { ...fs, promises: { ...fs.promises,
    rename: async () => { throw new Error('synthetic rename failure'); }
  } } });
  const result = await failing.writeFile(file, 'after', dir);
  assert.equal(result.success, false); assert.match(result.error, /rename failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before'); assert.deepEqual(fs.readdirSync(dir), ['file']);
});

test('editor IPC echoes request IDs for successful and rejected reads and saves', async t => {
  const dir = fixture(t), file = path.join(dir, 'file.svg'); fs.writeFileSync(file, '<svg/>');
  const handlers = new Map(), messages = [];
  editor.setupIPC({ on: (channel, handler) => handlers.set(channel, handler), handle() {} });
  const event = { sender: { isDestroyed: () => false, send: (channel, result) => messages.push({ channel, result }) } };
  let requestId = 0;
  for (const channel of [IPC.READ_FILE, IPC.READ_FILE_DATA_URL, IPC.WRITE_FILE]) {
    for (const projectPath of [dir, null]) {
      await handlers.get(channel)(event, { requestId: ++requestId, filePath: file, projectPath, content: '<svg/>' });
      assert.equal(messages.at(-1).result.requestId, requestId);
      assert.equal(messages.at(-1).result.success, projectPath !== null);
    }
  }
});

test('video IPC opens only existing project videos in the system player and reports failures', async t => {
  const dir = fixture(t), outside = fixture(t), opened = [], handlers = new Map();
  let playerError = '';
  const module = loadModule('src/main/fileEditor.js', {
    electron: { shell: { openPath: async file => { opened.push(file); return playerError; } } }
  });
  module.setupIPC({ on() {}, handle: (channel, handler) => handlers.set(channel, handler) });
  const open = filePath => handlers.get(IPC.OPEN_VIDEO)(null, { filePath, projectPath: dir });
  const video = path.join(dir, 'clip.MP4');
  // Larger than the text/image editor limit: video must never be read into IPC.
  fs.writeFileSync(video, ''); fs.truncateSync(video, 12 * 1024 * 1024);
  assert.equal((await open(video)).success, true);
  assert.deepEqual(opened, [fs.realpathSync(video)]);
  const script = path.join(dir, 'run.sh'); fs.writeFileSync(script, 'echo test');
  const escaped = path.join(outside, 'outside.mp4'); fs.writeFileSync(escaped, '');
  fs.symlinkSync(script, path.join(dir, 'script.mp4'));
  fs.symlinkSync(escaped, path.join(dir, 'escape.mp4'));
  fs.mkdirSync(path.join(dir, 'directory.mp4'));
  for (const file of [script, escaped, 'missing.mp4', 'script.mp4', 'escape.mp4', 'directory.mp4', '.git/clip.mp4']) {
    assert.equal((await open(path.isAbsolute(file) ? file : path.join(dir, file))).success, false, file);
  }
  assert.equal((await handlers.get(IPC.OPEN_VIDEO)(null, { filePath: video, projectPath: '/' })).success, false);
  assert.deepEqual(opened, [fs.realpathSync(video)]);
  playerError = 'No application can open this file';
  assert.equal((await open(video)).error, playerError);
});
