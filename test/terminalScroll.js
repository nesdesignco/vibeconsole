// Real Chromium scroll/layout regression tests, isolated from user sessions and PTYs.
// Run with: node test/terminalScroll.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-scroll-'));
  require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, 'fixtures/terminalScrollRenderer.js')],
    bundle: true, platform: 'browser', loader: { '.ttf': 'file' }, outfile: path.join(dir, 'renderer.js')
  });
  const root = path.join(__dirname, '..');
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head>
    <link rel="stylesheet" href="file://${root}/node_modules/@xterm/xterm/css/xterm.css">
    <link rel="stylesheet" href="file://${root}/src/renderer/styles/components/terminal.css">
    <style>*{box-sizing:border-box}body{margin:0}#host{width:900px;height:600px}</style>
    </head><body><div id="host"></div><script src="renderer.js"></script></body></html>`);
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, dir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: 'inherit', timeout: 45000
  });
  if (result.error) console.error(result.error);
  if (result.signal) console.error(`Electron test terminated by ${result.signal}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(process.argv[2], 'userData'));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1000, height: 750, show: true,
      webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await win.loadFile(path.join(process.argv[2], 'index.html'));
      const results = await win.webContents.executeJavaScript('window.runScrollTests()');
      for (const result of results) console.log(JSON.stringify(result));
      app.exit(results.some(r => !r.pass) ? 1 : 0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
