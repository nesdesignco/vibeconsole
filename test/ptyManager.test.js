const test = require('node:test');
const assert = require('node:assert/strict');

const { IPC } = require('../src/shared/ipcChannels');

// node-pty is a native module built for Electron's ABI; stub it so the
// manager's lifecycle logic can run under plain Node.
const spawnCalls = [];

function createFakePty() {
  const fake = {
    killed: false,
    writes: [],
    cols: 80,
    rows: 24,
    _exitHandlers: [],
    _dataHandlers: [],
    onData: (handler) => {
      fake._dataHandlers.push(handler);
      return { dispose: () => { fake.dataDisposed = true; } };
    },
    emitData: (chunk) => fake._dataHandlers.forEach(h => h(chunk)),
    onExit: (handler) => { fake._exitHandlers.push(handler); },
    write: (data) => fake.writes.push(data),
    resize: (cols, rows) => { fake.cols = cols; fake.rows = rows; },
    kill: () => { fake.killed = true; },
    emitExit: (exitCode = 0) => fake._exitHandlers.forEach(h => h({ exitCode, signal: 0 }))
  };
  return fake;
}

const nodePtyPath = require.resolve('node-pty');
require.cache[nodePtyPath] = {
  id: nodePtyPath,
  filename: nodePtyPath,
  loaded: true,
  exports: {
    spawn: (shell, args, opts) => {
      const fake = createFakePty();
      spawnCalls.push({ shell, args, opts, fake });
      return fake;
    }
  }
};

const ptyManager = require('../src/main/ptyManager');

const sentMessages = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => sentMessages.push({ channel, payload })
  }
};

ptyManager.init(fakeWindow);

test('createTerminal spawns a shell and tracks the instance', () => {
  const id = ptyManager.createTerminal('/tmp', '/tmp/project');

  assert.match(id, /^term-\d+$/);
  assert.equal(ptyManager.hasTerminal(id), true);
  assert.equal(ptyManager.getTerminalCount(), 1);
  assert.deepEqual(ptyManager.getTerminalInfo(id), { cwd: '/tmp', projectPath: '/tmp/project' });

  const call = spawnCalls.at(-1);
  assert.equal(call.opts.cwd, '/tmp');
  assert.equal(call.opts.name, 'xterm-256color');

  ptyManager.destroyTerminal(id);
});

test('createTerminal rejects shells outside the allowlist', () => {
  assert.throws(
    () => ptyManager.createTerminal('/tmp', null, '/usr/bin/evil-binary'),
    /Shell not allowed/
  );
});

test('writeToTerminal and resizeTerminal route to the right instance', () => {
  const id = ptyManager.createTerminal('/tmp', null);
  const { fake } = spawnCalls.at(-1);

  ptyManager.writeToTerminal(id, 'echo hi\r');
  assert.deepEqual(fake.writes, ['echo hi\r']);

  ptyManager.resizeTerminal(id, 120, 40);
  assert.equal(fake.cols, 120);
  assert.equal(fake.rows, 40);

  ptyManager.resizeTerminal(id, 0, -1);
  assert.equal(fake.cols, 120, 'invalid sizes are ignored');

  ptyManager.writeToTerminal('term-unknown', 'noop');

  ptyManager.destroyTerminal(id);
});

test('getTerminalsByProject filters by project path', () => {
  const a = ptyManager.createTerminal('/tmp', '/proj/a');
  const b = ptyManager.createTerminal('/tmp', '/proj/b');
  const g = ptyManager.createTerminal('/tmp', null);

  assert.deepEqual(ptyManager.getTerminalsByProject('/proj/a'), [a]);
  assert.deepEqual(ptyManager.getTerminalsByProject(null), [g]);

  ptyManager.destroyAll();
  assert.equal(ptyManager.getTerminalCount(), 0);
  void b;
});

test('destroyTerminal kills the pty and forgets the instance', () => {
  const id = ptyManager.createTerminal('/tmp', null);
  const { fake } = spawnCalls.at(-1);

  ptyManager.destroyTerminal(id);
  assert.equal(fake.killed, true);
  assert.equal(ptyManager.hasTerminal(id), false);
});

test('pty exit notifies renderer and removes the instance', () => {
  const id = ptyManager.createTerminal('/tmp', null);
  const { fake } = spawnCalls.at(-1);

  fake.emitExit(0);

  assert.equal(ptyManager.hasTerminal(id), false);
  const destroyed = sentMessages.find(m => m.payload && m.payload.terminalId === id && 'exitCode' in m.payload);
  assert.ok(destroyed, 'TERMINAL_DESTROYED should be sent to renderer');
});

test('getAvailableShells returns existing shells with default first', () => {
  const shells = ptyManager.getAvailableShells();
  assert.ok(shells.length > 0);
  for (const shell of shells) {
    assert.ok(shell.id && shell.name && shell.path);
  }
  if (process.platform !== 'win32') {
    assert.ok(shells.some(s => s.path === '/bin/sh'));
  }
});

function outputMessagesFor(terminalId) {
  return sentMessages.filter(m => m.channel === IPC.TERMINAL_OUTPUT_ID && m.payload.terminalId === terminalId);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('rapid pty output is coalesced into a single IPC message', async () => {
  sentMessages.length = 0;
  const id = ptyManager.createTerminal('/tmp', '/tmp/coalesce');
  const { fake } = spawnCalls.at(-1);

  for (let i = 0; i < 50; i++) fake.emitData(`chunk${i} `);

  // Nothing is sent synchronously; the burst is still buffered.
  assert.equal(outputMessagesFor(id).length, 0);

  await sleep(40);

  const messages = outputMessagesFor(id);
  assert.equal(messages.length, 1, 'expected one coalesced message');
  assert.equal(messages[0].payload.data, Array.from({ length: 50 }, (_, i) => `chunk${i} `).join(''));

  ptyManager.destroyTerminal(id);
});

test('pending output is flushed before the exit notification', async () => {
  sentMessages.length = 0;
  const id = ptyManager.createTerminal('/tmp', '/tmp/exitflush');
  const { fake } = spawnCalls.at(-1);

  fake.emitData('goodbye\r\n');
  fake.emitExit(0);

  const channels = sentMessages.filter(m => m.payload.terminalId === id).map(m => m.channel);
  const outputIdx = channels.indexOf(IPC.TERMINAL_OUTPUT_ID);
  const destroyedIdx = channels.indexOf(IPC.TERMINAL_DESTROYED);

  assert.ok(outputIdx !== -1, 'trailing output must not be dropped on exit');
  assert.ok(outputIdx < destroyedIdx, 'output must be sent before the exit notification');
  assert.equal(outputMessagesFor(id)[0].payload.data, 'goodbye\r\n');
});

test('output exceeding the buffer cap flushes immediately', async () => {
  sentMessages.length = 0;
  const id = ptyManager.createTerminal('/tmp', '/tmp/bigburst');
  const { fake } = spawnCalls.at(-1);

  fake.emitData('x'.repeat(300 * 1024));

  // No timer wait: the cap forces a synchronous flush.
  assert.equal(outputMessagesFor(id).length, 1);
  assert.equal(outputMessagesFor(id)[0].payload.data.length, 300 * 1024);

  ptyManager.destroyTerminal(id);
});

test('destroyTerminal flushes buffered output instead of discarding it', async () => {
  sentMessages.length = 0;
  const id = ptyManager.createTerminal('/tmp', '/tmp/destroyflush');
  const { fake } = spawnCalls.at(-1);

  fake.emitData('partial line');
  ptyManager.destroyTerminal(id);

  assert.equal(outputMessagesFor(id).length, 1);
  assert.equal(outputMessagesFor(id)[0].payload.data, 'partial line');
});
