const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadModule } = require('./helpers/loadModule');
const { IPC } = require('../src/shared/ipcChannels');
function fixture() {
  const events = new EventEmitter(), handlers = new Map(), sent = [], timers = [];
  let checks = 0, installs = 0;
  events.checkForUpdates = async () => { checks++; events.emit('checking-for-update'); events.emit('update-available', { version: '2' }); };
  events.downloadUpdate = () => new Promise(() => {});
  events.quitAndInstall = () => installs++;
  const updater = loadModule('src/main/autoUpdater.js', {
    electron: { app: { isPackaged: true, getVersion: () => '1' } },
    'electron-updater': { autoUpdater: events }
  }, { process: { ...process, platform: 'linux' },
    setTimeout: fn => { timers.push(fn); return timers.length; }, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {}, clearTimeout() {} });
  updater.init({ isDestroyed: () => false, webContents: { send: (channel, data) => sent.push({ channel, data }) } });
  updater.setupIPC({ on: (channel, fn) => handlers.set(channel, fn), handle: (channel, fn) => handlers.set(channel, fn) });
  return { updater, events, sent, timers, state: () => handlers.get(IPC.GET_UPDATE_STATE)(),
    invoke: channel => handlers.get(channel)(), checks: () => checks, installs: () => installs };
}

for (const status of ['downloading', 'downloaded']) {
  test(`manual and periodic checks preserve ${status} state and suppress stale events`, async () => {
    const f = fixture(); f.events.emit('update-available', { version: '2' });
    if (status === 'downloaded') f.events.emit('update-downloaded', { version: '2' });
    else { f.invoke(IPC.DOWNLOAD_UPDATE); f.events.emit('download-progress', { percent: 42 }); }
    await f.invoke(IPC.CHECK_FOR_UPDATES); for (const timer of f.timers) timer();
    assert.equal(f.checks(), 0);
    const count = f.sent.length;
    f.events.emit('checking-for-update'); f.events.emit('update-available', { version: '2' });
    f.events.emit('update-available', { version: '3' }); f.events.emit('update-not-available', { version: '1' });
    assert.equal(f.sent.length, count); assert.equal(f.state().status, status); assert.equal(f.state().updateInfo.version, '2');
    if (status === 'downloading') assert.equal(f.state().progress.percent, 42);
    else { await f.invoke(IPC.INSTALL_UPDATE); assert.equal(f.installs(), 1); }
  });
}

test('a failed check cannot invalidate a completed download', async () => {
  const f = fixture();
  f.events.checkForUpdates = async () => {
    f.events.emit('checking-for-update'); f.events.emit('update-downloaded', { version: '2' });
    throw new Error('synthetic check failure');
  };
  const result = await f.invoke(IPC.CHECK_FOR_UPDATES);
  assert.match(result.error, /synthetic check failure/);
  assert.equal(f.state().status, 'downloaded');
  await f.invoke(IPC.INSTALL_UPDATE); assert.equal(f.installs(), 1);
});

test('download cancellation and actual download failures still reset progress and allow checks', async () => {
  for (const event of ['update-cancelled', 'error']) {
    const f = fixture(); f.events.emit('update-available', { version: '2' }); f.invoke(IPC.DOWNLOAD_UPDATE);
    f.events.emit(event, new Error('synthetic download failure'));
    assert.equal(f.state().status, event === 'error' ? 'error' : 'available');
    await f.invoke(IPC.CHECK_FOR_UPDATES); assert.equal(f.checks(), 1); assert.equal(f.state().status, 'available');
  }
});

test('renderer keeps Restart now and installation state through stale control events and snapshots', async () => {
  const { createElements } = require('./helpers/loadModule');
  const element = createElements(), handlers = new Map(), sends = [];
  let reply;
  const modal = loadModule('src/renderer/updaterModal.js', {
    './electronBridge': { ipcRenderer: {
      on: (channel, fn) => handlers.set(channel, fn),
      invoke: () => new Promise(resolve => { reply = resolve; }), send: channel => sends.push(channel)
    } },
    './escapeHtml': { escapeHtml: String, escapeAttr: String }
  }, { document: { getElementById: element, addEventListener() {} } });
  modal.init();
  handlers.get(IPC.UPDATE_DOWNLOADED)(null, { version: '2' });
  reply({ status: 'available', updateInfo: { version: '2' } }); await Promise.resolve();
  for (const status of ['downloaded', 'installing']) {
    handlers.get(IPC.UPDATE_CHECKING)(); handlers.get(IPC.UPDATE_AVAILABLE)(null, { version: '3' });
    handlers.get(IPC.UPDATE_NOT_AVAILABLE)(null, { currentVersion: '1' });
    assert.equal(element('#updater-modal-title').textContent, status === 'downloaded' ? 'Update downloaded' : 'Installing update…');
    if (status === 'downloaded') {
      assert.equal(element('#updater-btn-primary').textContent, 'Restart now');
      element('#updater-btn-primary').listeners.get('click')();
      assert.deepEqual(sends, [IPC.INSTALL_UPDATE]);
    }
  }
});
