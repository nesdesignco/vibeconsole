// Real Electron + PTY integration; fake CLI entry points avoid account access.
// Run after build:renderer with: node test/aiToolsApp.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AI_TOOLS } = require('../src/shared/aiTools');
const { IPC } = require('../src/shared/ipcChannels');
const root = path.join(__dirname, '..');

if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ai-tools-'));
  try {
    require('esbuild').buildSync({
      stdin: { contents: `require('./src/renderer/index'); window.aiTest = { state: require('./src/renderer/state'), terminal: require('./src/renderer/terminal') }; require('./src/renderer/electronBridge').clipboard.writeText = text => { window.aiTest.copiedText = text; };`, resolveDir: root },
      bundle: true, platform: 'browser', loader: { '.ttf': 'file' }, outfile: path.join(dir, 'renderer.js')
    });
    fs.writeFileSync(path.join(dir, 'index.html'), fs.readFileSync(path.join(root, 'index.html'), 'utf8')
      .replace('<head>', `<head><base href="${pathToFileURL(root + path.sep).href}">`)
      .replace('src="dist/renderer.js"', `src="${pathToFileURL(path.join(dir, 'renderer.js')).href}"`));
    fs.mkdirSync(path.join(dir, 'CLI Tools'));
    fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ success: true, data: { permissions: [
      { name: 'Screen Recording', isRequired: true, isGranted: false, grantInstructions: 'Enable the test host in macOS Settings.' },
      { name: 'Accessibility', isRequired: true, isGranted: false },
      { name: 'Event Synthesizing', isRequired: false, isGranted: false }
    ] } }));
    const peekabooFixture = `#!${process.execPath}\nconst fs = require('node:fs'); if (process.argv.slice(2).join(' ') !== 'permissions status --json') process.exit(90); process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, 'permissions.json'))}));\n`;
    fs.writeFileSync(path.join(dir, 'peekaboo-fixture'), peekabooFixture);
    fs.writeFileSync(path.join(dir, 'CLI Tools', 'brew'), `#!${process.execPath}\nconst fs = require('node:fs'); if (process.argv.slice(2).join(' ') !== 'install openclaw/tap/peekaboo') process.exit(91); fs.copyFileSync(${JSON.stringify(path.join(dir, 'peekaboo-fixture'))}, ${JSON.stringify(path.join(dir, 'CLI Tools', 'peekaboo'))}); fs.chmodSync(${JSON.stringify(path.join(dir, 'CLI Tools', 'peekaboo'))}, 0o755);\n`, { mode: 0o755 });
    for (const tool of Object.values(AI_TOOLS)) {
      fs.writeFileSync(path.join(dir, 'CLI Tools', tool.command),
        `#!${process.execPath}\nconsole.log('CLI_READY'); process.stdin.resume(); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    }
    // Grok can shadow Cursor's generic `agent` command on PATH.
    fs.writeFileSync(path.join(dir, 'CLI Tools', 'agent'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    const args = [__filename, dir];
    if (process.platform === 'linux') args.unshift('--no-sandbox');
    const result = require('node:child_process').spawnSync(require('electron'), args, {
      cwd: root, env: { ...process.env, PATH: `${path.join(dir, 'CLI Tools')}:/usr/bin:/bin`, ELECTRON_RUN_AS_NODE: '', NODE_ENV: 'test', VIBE_SMOKE: '', VIBE_USER_DATA_DIR: path.join(dir, 'profile') },
      stdio: 'inherit', timeout: 60000
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  const dir = process.argv.at(-1);
  // workspace.js uses homedir independently of Electron userData.
  os.homedir = () => dir;
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
  const terminalInputs = [];
  ipcMain.on(IPC.TERMINAL_INPUT_ID, (_event, value) => terminalInputs.push(value));
  const pty = require('node-pty');
  const spawn = pty.spawn;
  pty.spawn = (_shell, _args, options) => spawn('/bin/sh', ['-i'], {
    ...options, env: { ...options.env, ENV: '', PATH: `${path.join(dir, 'CLI Tools')}:/usr/bin:/bin` }
  });
  const usageCalls = [];
  for (const id of ['claude', 'codex']) {
    const usage = require(`../src/main/${id}UsageManager`);
    usage.getCachedUsage = () => null;
    usage.fetchUsage = async () => {
      usageCalls.push(id);
      return { fiveHour: { utilization: 10 }, sevenDay: { utilization: 20 } };
    };
  }
  const opened = [];
  shell.openExternal = async url => { opened.push(url); };
  const loadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function() { return loadFile.call(this, path.join(dir, 'index.html')); };
  app.setAppPath(root);
  app.once('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.once('did-finish-load', async () => {
      const js = source => win.webContents.executeJavaScript(source);
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const waitFor = async (check, label) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await check()) return;
          await wait(50);
        }
        throw new Error(`Timed out: ${label}`);
      };
      const detector = require('../src/main/aiToolProcessDetector');
      let code = 1;
      try {
        await wait(1000);
        detector.stopPolling();
        await js(`window.aiTest.state.setProjectPath(${JSON.stringify(dir)})`);
        await wait(300);
        assert.equal(await js(`document.querySelectorAll('#ai-tool-selector .ai-tool-dropdown-item').length`), 8);
        for (const tool of Object.values(AI_TOOLS)) {
          await js(`document.querySelector('.ai-tool-dropdown-trigger').click(); document.querySelector('.ai-tool-dropdown-item[data-value="${tool.id}"]').click()`);
          await waitFor(() => js(`document.getElementById('btn-start-ai').textContent === ${JSON.stringify(`Start ${tool.shortName}`)}`), 'tool selection');
          assert.equal(await js(`document.getElementById('btn-start-ai').textContent`), `Start ${tool.shortName}`);
          const menu = require('../src/main/menu').getMenuTemplate().find(item => item.label === tool.menuLabel);
          assert.ok(menu, tool.name);
          if (tool.docsUrl) {
            menu.submenu.find(item => item.label?.endsWith('Setup Guide…')).click();
            assert.equal(opened.at(-1), tool.docsUrl);
          }
          // Also test the native menu start action goes through a fresh terminal.
          if (tool.id === 'kimi') menu.submenu.find(item => item.accelerator === 'CmdOrCtrl+K').click();
          else await js(`document.getElementById('btn-start-ai').click()`);
          await wait(650);
          // Tab rendering is debounced; wait for the visible state, not a fixed delay.
          await waitFor(async () => {
            await detector.pollOnce();
            return js(`document.querySelector('.usage-tool-name').textContent === ${JSON.stringify(tool.name)}`);
          }, 'toolbar identity');
          const state = await js(`(() => { const manager = window.aiTest.terminal.getMultiTerminalUI().getManager(); const t = manager.getTerminal(manager.activeTerminalId); return { ...t.state, name: document.querySelector('.usage-tool-name').textContent, metrics: document.querySelector('.usage-metrics').style.display }; })()`);
          assert.equal(state.aiTool, tool.id, tool.name);
          assert.equal(state.aiToolProcessDetected, true, tool.name);
          assert.equal(state.name, tool.name);
          assert.equal(state.metrics, tool.usageTracking ? '' : 'none');
          await js(`document.querySelector('.btn-computer').click()`);
          await waitFor(() => js(`document.querySelector('#computer-panel [data-target]').textContent === ${JSON.stringify(`Active: ${tool.name}`)}`), 'computer panel active agent');
          if (tool.id === 'claude') {
            await waitFor(() => js(`!!document.querySelector('#computer-panel [data-action="install"]') && !document.querySelector('#computer-panel [data-action="install"]').disabled`), 'computer install available');
            assert.equal(fs.existsSync(path.join(dir, 'CLI Tools', 'peekaboo')), false);
            await js(`document.querySelector('#computer-panel [data-action="install"]').click()`);
            await waitFor(() => js(`document.querySelectorAll('.computer-permission').length === 3`), 'Mac permissions read');
            assert.equal(await js(`document.querySelector('#computer-panel [data-action="prepare"]').disabled`), true);
            await js(`document.querySelector('#computer-panel [data-action="screen"]').click()`);
            await waitFor(() => opened.at(-1)?.endsWith('Privacy_ScreenCapture'), 'screen settings');
            const permissions = JSON.parse(fs.readFileSync(path.join(dir, 'permissions.json')));
            permissions.data.permissions.forEach(p => { p.isGranted = true; });
            fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify(permissions));
            await wait(150);
            await js(`document.querySelector('#computer-panel [data-action="refresh"]').click()`);
          }
          await waitFor(() => js(`!document.querySelector('#computer-panel [data-action="prepare"]').disabled`), 'Mac task preparation ready');
          await js(`document.querySelector('#computer-task').value = 'Open Safari and check the local test website.'`);
          if (tool.id === 'codex' && process.env.VIBE_TEST_COMPUTER_SCREENSHOT) {
            fs.writeFileSync(process.env.VIBE_TEST_COMPUTER_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
          }
          const inputsBefore = terminalInputs.length;
          await js(`document.querySelector('#computer-panel [data-action="prepare"]').click()`);
          await waitFor(() => terminalInputs.slice(inputsBefore).some(input => input.data.includes('Task: Open Safari')), 'Mac task reaches terminal');
          assert.ok(terminalInputs.slice(inputsBefore).every(input => input.terminalId === state.id));
          assert.ok(terminalInputs.slice(inputsBefore).every(input => !/[\r\n]/.test(input.data)), 'task draft must not send Enter');
          assert.equal(await js(`document.getElementById('computer-panel').classList.contains('visible')`), false);
          console.log(`PASS ${tool.name}: Computer Use installation/permissions and active-terminal task draft`);
          if (tool.id === 'kimi' && process.env.VIBE_TEST_SCREENSHOT) {
            await js(`document.querySelector('.ai-tool-dropdown-trigger').click()`);
            await wait(100);
            fs.writeFileSync(process.env.VIBE_TEST_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
            await js(`document.querySelector('.ai-tool-dropdown-trigger').click()`);
          }
          console.log(`PASS ${tool.name}: selection, menu, fresh PTY, process detection, toolbar`);
          await js(`(() => { const m = window.aiTest.terminal.getMultiTerminalUI().getManager(); m.closeTerminal(m.activeTerminalId); })()`);
        }
        const before = usageCalls.length;
        const event = { sender: win.webContents };
        for (const id of ['grok', 'gemini', 'copilot', 'cursor', 'qwen', 'kimi', 'constructor']) {
          ipcMain.emit(IPC.LOAD_AI_USAGE, event, id);
          ipcMain.emit(IPC.REFRESH_AI_USAGE, event, id);
        }
        await wait(50);
        assert.equal(usageCalls.length, before);
        assert.deepEqual([...new Set(usageCalls)].sort(), ['claude', 'codex']);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'profile', 'ai-tool-config.json'))).activeTool, 'kimi');
        console.log('PASS quota IPC isolation and persisted selection');
        const loadedLogos = await js(`Promise.all(Array.from(document.querySelectorAll('.ai-tool-dropdown-item .ai-tool-brand'), el => new Promise((resolve, reject) => {
          const image = new Image(); image.onload = () => resolve(image.naturalWidth > 0); image.onerror = reject;
          image.src = el.style.maskImage.slice(5, -2);
        })))`);
        assert.equal(loadedLogos.length, 6);
        assert.ok(loadedLogos.every(Boolean));
        win.focus();
        await js(`document.querySelector('.ai-tool-dropdown-trigger').click()`);
        for (const keyCode of ['Home', 'Down']) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        }
        await wait(50);
        assert.equal(await js(`document.activeElement.dataset.value`), 'codex');
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await wait(50);
        assert.equal(await js(`document.querySelector('.ai-tool-dropdown-menu').hidden`), true);
        assert.equal(await js(`document.activeElement.className`), 'ai-tool-dropdown-trigger');
        await js(`document.querySelector('.ai-tool-dropdown-trigger').click()`);
        for (const keyCode of ['Home', 'Enter']) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
          if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        }
        await waitFor(() => js(`document.getElementById('btn-start-ai').textContent === 'Start Claude'`), 'keyboard selection');
        assert.equal(await js(`document.activeElement.className`), 'ai-tool-dropdown-trigger');
        const sizes = await js(`(() => { const start = document.getElementById('btn-start-ai').getBoundingClientRect(); const trigger = document.querySelector('.ai-tool-dropdown-trigger').getBoundingClientRect(); return {start:start.height, trigger:trigger.height}; })()`);
        assert.equal(sizes.trigger, sizes.start);
        console.log('PASS brand logos, keyboard selection/focus and matching button heights');
        for (const tool of Object.values(AI_TOOLS)) {
          const executable = path.join(dir, 'CLI Tools', tool.command);
          const contents = fs.readFileSync(executable);
          fs.unlinkSync(executable);
          await js(`document.querySelector('.ai-tool-dropdown-trigger').click(); document.querySelector('.ai-tool-dropdown-item[data-value="${tool.id}"]').click()`);
          await waitFor(() => js(`document.getElementById('btn-start-ai').textContent === ${JSON.stringify(`Start ${tool.shortName}`)}`), 'missing tool selection');
          await js(`document.getElementById('btn-start-ai').click()`);
          await waitFor(() => js(`!!document.querySelector('.terminal-install-help')`), `${tool.name} installation help`);
          assert.equal(await js(`document.querySelector('.terminal-install-help code').textContent`), tool.installCommand);
          await js(`document.querySelector('.terminal-install-help button').click()`);
          await waitFor(() => js(`window.aiTest.copiedText === ${JSON.stringify(tool.installCommand)}`), 'installation command copied');
          await js(`document.querySelectorAll('.terminal-install-help button')[1].click()`);
          await waitFor(() => opened.at(-1) === tool.docsUrl, 'installation guide opened');
          if (tool.id === 'copilot') {
            if (process.env.VIBE_TEST_INSTALL_SCREENSHOT) {
              fs.writeFileSync(process.env.VIBE_TEST_INSTALL_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
            }
            await js(`document.querySelectorAll('.terminal-install-help button')[2].click()`);
            assert.equal(await js(`!!document.querySelector('.terminal-install-help')`), false);
            // Typed input must get the same guidance as the Start button.
            await js(`(() => {const m = window.aiTest.terminal.getTerminal(); m.getTerminal(m.activeTerminalId).terminal.input('copilot\\r', true);})()`);
            await waitFor(() => js(`!!document.querySelector('.terminal-install-help')`), 'typed missing command');
            // Split diagnostics, including split ANSI, must not lose the command.
            await js(`document.querySelectorAll('.terminal-install-help button')[2].click()`);
            win.webContents.send(IPC.TERMINAL_OUTPUT_ID, { terminalId: await js(`window.aiTest.terminal.getTerminal().activeTerminalId`), data: '\r\nzsh: command not fo\u001b[' });
            win.webContents.send(IPC.TERMINAL_OUTPUT_ID, { terminalId: await js(`window.aiTest.terminal.getTerminal().activeTerminalId`), data: '31mund: copilot\u001b[0m\r\n' });
            await waitFor(() => js(`!!document.querySelector('.terminal-install-help')`), 'split diagnostic');
          }
          fs.writeFileSync(executable, contents, { mode: 0o755 });
          await js(`window.aiTest.terminal.sendCommand(${JSON.stringify(tool.command)})`);
          await waitFor(async () => {
            await detector.pollOnce();
            return js(`window.aiTest.terminal.getTerminal().getActiveTerminalState().aiToolProcessDetected === true`);
          }, 'installed tool starts without restart');
          assert.equal(await js(`!!document.querySelector('.terminal-install-help')`), false);
          await js(`(() => {const m = window.aiTest.terminal.getTerminal(); m.closeTerminal(m.activeTerminalId);})()`);
          console.log(`PASS ${tool.name}: missing CLI guidance, copy, guide, retry after installation`);
        }
        fs.unlinkSync(path.join(dir, 'CLI Tools', 'kimi'));
        await waitFor(() => js(`!document.getElementById('btn-project-context').disabled`), 'context button ready');
        await js(`document.getElementById('btn-project-context').click()`);
        await waitFor(() => js(`!!document.querySelector('.terminal-install-help') && document.getElementById('btn-project-context').dataset.busy === '0'`), 'context stops immediately for missing CLI');
        console.log('PASS missing CLI context initialization exits without readiness timeout');
        code = 0;
      } catch (error) {
        console.error(error);
        console.error(await js(`(() => { const m = window.aiTest.terminal.getTerminal(); const t = m.getTerminal(m.activeTerminalId); return { state: t?.state, tail: t ? Array.from({length: Math.min(8,t.terminal.buffer.active.length)}, (_,i) => t.terminal.buffer.active.getLine(Math.max(0,t.terminal.buffer.active.cursorY-7)+i)?.translateToString(true)).join('\\n') : '' }; })()`));
      }
      finally {
        require('../src/main/ptyManager').destroyAll();
        win.destroy();
        app.exit(code);
      }
    });
  });
  require('../src/main/index');
}
