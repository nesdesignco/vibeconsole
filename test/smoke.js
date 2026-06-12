/**
 * Electron smoke test: launches the app with VIBE_SMOKE=1 and expects the
 * main window to finish loading the renderer within the timeout.
 * Run with: npm run test:smoke (requires dist/ to be built first)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

if (!fs.existsSync(path.join(root, 'dist', 'renderer.js'))) {
  console.error('dist/renderer.js missing — run "npm run build:fast" first');
  process.exit(1);
}

const args = [root];
if (process.platform === 'linux') {
  args.unshift('--no-sandbox');
}

const child = spawn(electronBin, args, {
  cwd: root,
  env: { ...process.env, VIBE_SMOKE: '1', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
const timeout = setTimeout(() => {
  console.error('SMOKE TIMEOUT: window did not finish loading in 30s');
  console.error(output);
  child.kill('SIGKILL');
  process.exit(1);
}, 30000);

child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

child.on('exit', (code) => {
  clearTimeout(timeout);
  if (code === 0 && output.includes('VIBE_SMOKE_OK')) {
    console.log('Smoke test passed: renderer loaded successfully');
    process.exit(0);
  }
  console.error(`Smoke test failed (exit code ${code})`);
  console.error(output);
  process.exit(1);
});
