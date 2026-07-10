const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MANUAL_INSTALL_SCRIPT } = require('../src/main/updaterInstallScript');

// The script uses macOS-only tools (ditto, xattr, open); CI runs on Linux.
const darwinOnly = { skip: process.platform !== 'darwin' ? 'macOS-only (ditto/xattr/open)' : false };

// A PID far beyond pid_max: `kill -0` fails immediately, so the script's
// wait-for-exit loop terminates on the first check.
const DEAD_PID = '99999999';

function setupFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-updater-test-'));

  const appPath = path.join(root, 'VibeConsole.app');
  fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Contents', 'marker.txt'), 'old');

  const newAppDir = path.join(root, 'staging', 'VibeConsole.app');
  fs.mkdirSync(path.join(newAppDir, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(newAppDir, 'Contents', 'marker.txt'), 'new');
  const zipPath = path.join(root, 'update.zip');
  execFileSync('/usr/bin/ditto', ['-ck', '--keepParent', newAppDir, zipPath]);

  // Stub `open` so the test never launches anything for real.
  const stubBin = path.join(root, 'stub-bin');
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const scriptPath = path.join(root, 'install.sh');
  fs.writeFileSync(scriptPath, MANUAL_INSTALL_SCRIPT, { mode: 0o700 });

  const env = { ...process.env, PATH: `${stubBin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  return { root, appPath, zipPath, scriptPath, env };
}

test('manual install script swaps the bundle, cleans up, and self-deletes', darwinOnly, () => {
  const { root, appPath, zipPath, scriptPath, env } = setupFixture();
  try {
    execFileSync('/bin/sh', [scriptPath, DEAD_PID, zipPath, appPath], { env });

    const marker = fs.readFileSync(path.join(appPath, 'Contents', 'marker.txt'), 'utf8');
    assert.equal(marker, 'new');

    const oldLeftovers = fs.readdirSync(root).filter((name) => name.includes('.old.'));
    assert.deepEqual(oldLeftovers, []);
    assert.equal(fs.existsSync(scriptPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual install script leaves the current app untouched when the zip is missing', darwinOnly, () => {
  const { root, appPath, scriptPath, env } = setupFixture();
  try {
    assert.throws(() => {
      execFileSync('/bin/sh', [scriptPath, DEAD_PID, path.join(root, 'missing.zip'), appPath], { env });
    });

    const marker = fs.readFileSync(path.join(appPath, 'Contents', 'marker.txt'), 'utf8');
    assert.equal(marker, 'old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
