// Full application scroll tests: production IPC/PTY, toolbar and ResizeObserver.
// No production test hooks; the test entry shares the real renderer's modules.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');

if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-scroll-app-'));
  try {
    require('esbuild').buildSync({
      stdin: { contents: `require('./src/renderer/index.js'); require('./test/fixtures/terminalScrollAppRenderer.js');`, resolveDir: root },
      bundle: true, platform: 'browser', loader: { '.ttf': 'file' }, outfile: path.join(dir, 'renderer.js')
    });
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
      .replace('<head>', `<head><base href="${pathToFileURL(root + path.sep).href}">`)
      .replace('src="dist/renderer.js"', `src="${pathToFileURL(path.join(dir, 'renderer.js')).href}"`);
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    const args = [__filename, dir];
    if (process.platform === 'linux') args.unshift('--no-sandbox');
    const result = require('node:child_process').spawnSync(require('electron'), args, {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_ENV: 'test', VIBE_SMOKE: '', VIBE_USER_DATA_DIR: path.join(dir, 'userData') },
      stdio: 'inherit', timeout: 60000
    });
    if (result.error) console.error(result.error);
    if (result.signal) console.error(`Electron app test terminated by ${result.signal}`);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = require('electron');
  const loadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function() {
    return loadFile.call(this, path.join(process.argv.at(-1), 'index.html'));
  };
  app.once('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', async () => {
      let code = 1;
      try {
        const results = await win.webContents.executeJavaScript('window.runAppScrollTests()');
        for (const result of results) console.log(JSON.stringify(result));
        code = results.some(result => !result.pass) ? 1 : 0;
      } catch (error) {
        console.error(error);
      } finally {
        // app.exit bypasses before-quit, so explicitly clean up our test PTYs.
        require('../src/main/ptyManager').destroyAll();
        win.destroy();
        app.exit(code);
      }
    });
  });
  require('../src/main/index');
}
