const test = require('node:test');
const assert = require('node:assert/strict');

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
    onData: () => ({ dispose: () => { fake.dataDisposed = true; } }),
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
