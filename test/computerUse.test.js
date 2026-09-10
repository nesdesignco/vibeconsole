const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('./helpers/loadModule');
const { IPC } = require('../src/shared/ipcChannels');
const { AI_TOOLS } = require('../src/shared/aiTools');

test('Mac control checks permissions without acting, installs once, and only opens known permission panes', async () => {
  const calls = [], opened = [], handlers = new Map();
  let installed = false, finishInstall, failInstall = false;
  let permissions = [{ name: 'Screen Recording', isRequired: true, isGranted: false, grantInstructions: 'Enable the Bridge host' }];
  const manager = loadModule('src/main/computerUse.js', {
    os: { release: () => '24.0.0', homedir: () => '/test-home' },
    electron: { shell: { openExternal: url => { opened.push(url); } } },
    '../shared/pathUtils': { findExecutable: name => name === 'brew' || installed ? `/test-bin/${name}` : undefined },
    './gitExecUtils': { execFileCmd: async (cmd, args, cwd) => {
      calls.push([cmd, [...args], cwd]);
      if (cmd.endsWith('/brew')) {
        if (failInstall) throw new Error('Installer failed');
        await new Promise(resolve => { finishInstall = resolve; });
        installed = true;
      }
      return { stdout: JSON.stringify({ success: true, data: { permissions } }) };
    } }
  }, { process: { platform: 'darwin' } });
  manager.setupIPC({ handle: (channel, callback) => handlers.set(channel, callback) });
  assert.equal((await manager.getStatus()).installed, false);
  assert.equal(calls.length, 0);
  const pending = manager.install();
  assert.equal((await manager.install()).success, false);
  finishInstall();
  assert.equal((await pending).success, true);
  assert.deepEqual(calls[0], ['/test-bin/brew', ['install', 'openclaw/tap/peekaboo'], '/test-home']);
  assert.equal((await manager.install()).success, true);
  assert.equal(calls.length, 1);
  const status = await manager.getStatus();
  assert.equal(status.permissions[0].granted, false);
  assert.equal(status.permissions[0].instructions, 'Enable the Bridge host');
  assert.deepEqual(calls.at(-1)[1], ['permissions', 'status', '--json']);
  permissions = [{ name: 'Accessibility', isRequired: true, isGranted: 'yes' }];
  assert.match((await manager.getStatus()).error, /Unexpected permission status/);
  for (const value of ['file:///tmp', 'constructor', {}, null]) {
    assert.equal((await handlers.get(IPC.OPEN_COMPUTER_PERMISSION)({}, value)).success, false);
  }
  assert.equal(opened.length, 0);
  assert.equal((await handlers.get(IPC.OPEN_COMPUTER_PERMISSION)({}, 'screen')).success, true);
  assert.match(opened[0], /Privacy_ScreenCapture$/);
  installed = false; failInstall = true;
  assert.equal((await manager.install()).success, false);
  assert.equal((await manager.getStatus()).installing, false);
});

test('Mac control refuses unsupported platforms and old macOS without executing anything', async () => {
  for (const [platform, release] of [['linux', '30.0.0'], ['darwin', '23.0.0']]) {
    const manager = loadModule('src/main/computerUse.js', {
      os: { release: () => release }, electron: {},
      '../shared/pathUtils': { findExecutable: () => undefined },
      './gitExecUtils': { execFileCmd: () => assert.fail('must not execute') }
    }, { process: { platform } });
    assert.equal((await manager.getStatus()).supported, false);
    assert.equal((await manager.install()).success, false);
  }
});

test('computer tasks go only to the current running agent, as a draft, with correctly quoted CLI paths', () => {
  let active, pasted;
  const panel = loadModule('src/renderer/computerUse.js', { './electronBridge': {}, './escapeHtml': {} }, {
    window: { terminalGetActiveState: () => active, terminalPasteText: (text, id) => { pasted = { text, id }; return true; } }
  });
  assert.throws(() => panel.prepareTask('Open Safari', '/bin/peekaboo'), /running AI/);
  for (const tool of Object.values(AI_TOOLS)) {
    active = { id: `terminal-${tool.id}`, aiTool: tool.id, aiToolProcessDetected: true };
    panel.prepareTask('Open Safari', "/Tools/it's Peekaboo/peekaboo");
    assert.equal(pasted.id, active.id);
    assert.match(pasted.text, /Task: Open Safari/);
    assert.match(pasted.text, /'\/Tools\/it'\\''s Peekaboo\/peekaboo'/);
    assert.match(pasted.text, /permissions status --json/);
    assert.doesNotMatch(pasted.text, /[\r\n]/);
  }
  active.aiToolProcessDetected = false;
  assert.throws(() => panel.prepareTask('Open Safari', '/bin/peekaboo'), /running AI/);
  active.aiToolProcessDetected = true;
  assert.throws(() => panel.prepareTask('  ', '/bin/peekaboo'), /Describe/);
});
