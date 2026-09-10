const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, createElements } = require('./helpers/loadModule');
const { AI_TOOLS } = require('../src/shared/aiTools');
const { IPC } = require('../src/shared/ipcChannels');

test('tool selection persists, broadcasts and rebuilds the application menu', () => {
  const handlers = new Map();
  const sent = [];
  let saved, rebuilt = 0;
  const manager = loadModule('src/main/aiToolManager.js', {
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
    fs: { existsSync: () => false, writeFileSync: (_file, data) => { saved = JSON.parse(data); } }
  });
  manager.init({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
    { getPath: () => '/tmp' }, () => rebuilt++);
  for (const id of Object.keys(AI_TOOLS)) {
    assert.equal(handlers.get(IPC.SET_AI_TOOL)({}, id), true);
    assert.equal(saved.activeTool, id);
    assert.equal(manager.getConfig().activeTool.id, id);
    assert.equal(sent.at(-1)[1].id, id);
  }
  assert.equal(rebuilt, 8);
  assert.equal(manager.setActiveTool('unavailable'), false);
});

test('toolbar shows each agent identity and never requests another provider quota', () => {
  const sent = [], callbacks = new Map();
  const mocks = Object.fromEntries(['skillsPanel', 'appearance', 'computerUse', 'lucideIcons', 'githubPanel',
    'savedPromptsPanel', 'updaterModal', 'aiToolSelector', 'toast', 'escapeHtml'].map(name => [`./${name}`, {}]));
  mocks['./aiToolSelector'] = { AI_TOOL_ICONS: {} };
  mocks['./electronBridge'] = { ipcRenderer: { send: (...args) => sent.push(args) } };
  const { TerminalTabBar } = loadModule('src/renderer/terminalTabBar.js', mocks);
  const element = createElements();
  const bars = element('.ai-usage-bars');
  bars.querySelectorAll = () => [];
  const bar = Object.create(TerminalTabBar.prototype);
  bar.element = { querySelector: element };
  bar._addIpcListener = (channel, fn) => callbacks.set(channel, fn);
  bar._usageRetryCount = 0;
  bar._setupUsageListener();
  const select = id => bar._updateUsageVisibility({ activeTerminalId: 'one', terminals: [{ id: 'one', aiTool: id }] });
  select('claude');
  assert.deepEqual(sent.pop(), [IPC.LOAD_AI_USAGE, 'claude']);
  callbacks.get(IPC.AI_USAGE_DATA)({}, { toolId: 'claude', fiveHour: null, sevenDay: null });
  assert.ok(bar._usageRetryTimer);
  for (const tool of Object.values(AI_TOOLS).filter(tool => !tool.usageTracking)) {
    select(tool.id);
    assert.equal(element('.usage-tool-name').textContent, tool.name);
    assert.equal(element('.usage-metrics').style.display, 'none');
    assert.equal(bar._currentUsageTool, null);
    assert.equal(bar._usageRetryTimer, null);
    assert.match(bars.title, /Usage tracking is not available/);
  }
  assert.equal(sent.length, 0);
  select('codex');
  assert.deepEqual(sent.pop(), [IPC.LOAD_AI_USAGE, 'codex']);
  assert.equal(element('.usage-metrics').style.display, '');
  select(null);
  assert.equal(bars.style.display, 'none');
});
