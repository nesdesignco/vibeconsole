/**
 * Auto Updater Module
 * Uses electron-updater for automatic updates via GitHub Releases.
 */

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { CancellationToken } = require('builder-util-runtime');
const { IPC } = require('../shared/ipcChannels');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);

let mainWindow = null;
let checkInterval = null;
let initialCheckTimeout = null;
let listenersRegistered = false;
let cancellationToken = null;
let downloadInFlight = false;
let downloadedFile = null;
let installRequested = false;

// Persistent state for renderer queries (when modal opens after the event fired)
let state = {
  status: 'idle', // idle | checking | available | downloading | downloaded | error | not-available
  updateInfo: null, // { version, releaseNotes, releaseDate, releaseName }
  progress: null,   // { percent, bytesPerSecond, transferred, total }
  error: null,      // { message }
  currentVersion: app.getVersion()
};

function isAutoUpdateSupported() {
  return app.isPackaged === true;
}

function safeSend(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function normalizeUpdateInfo(info) {
  if (!info) return null;
  return {
    version: info.version,
    releaseNotes: info.releaseNotes != null ? info.releaseNotes : '',
    releaseDate: info.releaseDate || '',
    releaseName: info.releaseName || ''
  };
}

function resetDownload() {
  downloadInFlight = false;
  cancellationToken = null;
}

function handleDownloadCancelled() {
  state.status = state.updateInfo ? 'available' : 'idle';
  state.progress = null;
  resetDownload();
  safeSend(IPC.UPDATE_CANCELLED);
}

function ensureEventListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  autoUpdater.on('checking-for-update', () => {
    state.status = 'checking';
    state.error = null;
    safeSend(IPC.UPDATE_CHECKING);
  });

  autoUpdater.on('update-available', (info) => {
    state.status = 'available';
    state.updateInfo = normalizeUpdateInfo(info);
    state.progress = null;
    state.error = null;
    safeSend(IPC.UPDATE_AVAILABLE, state.updateInfo);
  });

  autoUpdater.on('update-not-available', (info) => {
    // Only transition to not-available if we're not already past that point.
    if (state.status === 'downloading' || state.status === 'downloaded') return;
    state.status = 'not-available';
    // Keep updateInfo null: storing the "latest == current" info here would
    // defeat the !state.updateInfo guard in DOWNLOAD_UPDATE.
    state.updateInfo = null;
    safeSend(IPC.UPDATE_NOT_AVAILABLE, { currentVersion: app.getVersion(), latestVersion: info && info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    const previousPercent = state.progress ? state.progress.percent : -1;
    state.status = 'downloading';
    state.progress = {
      percent: Math.round(progress.percent || 0),
      bytesPerSecond: progress.bytesPerSecond || 0,
      transferred: progress.transferred || 0,
      total: progress.total || 0
    };
    // electron-updater emits per received chunk; only forward to the renderer
    // when the displayed (rounded) percent actually changes.
    if (state.progress.percent === previousPercent) return;
    safeSend(IPC.UPDATE_DOWNLOAD_PROGRESS, state.progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    state.status = 'downloaded';
    state.updateInfo = normalizeUpdateInfo(info) || state.updateInfo;
    downloadedFile = (info && info.downloadedFile) || null;
    resetDownload();
    safeSend(IPC.UPDATE_DOWNLOADED, state.updateInfo);
  });

  autoUpdater.on('update-cancelled', handleDownloadCancelled);

  autoUpdater.on('error', (err) => {
    const message = (err && err.message) ? err.message : 'Update error';
    // CancellationError is reported as an error too; treat it as cancellation.
    if (err && err.name === 'CancellationError') {
      handleDownloadCancelled();
      return;
    }
    // A failed background check must not invalidate an update that is already
    // downloaded and ready to install. But if the user just asked to install,
    // surface the failure instead of silently doing nothing.
    if (state.status === 'downloaded') {
      resetDownload();
      console.error('Auto-update error (update already downloaded, keeping state):', message);
      if (installRequested) {
        installRequested = false;
        safeSend(IPC.UPDATE_ERROR, { message: `Install failed: ${message}` });
      }
      return;
    }
    state.status = 'error';
    state.error = { message };
    resetDownload();
    safeSend(IPC.UPDATE_ERROR, { message });
  });
}

function init(window) {
  mainWindow = window;
  state.currentVersion = app.getVersion();

  if (!isAutoUpdateSupported()) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  ensureEventListeners();

  initialCheckTimeout = setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Auto-update check failed:', err && err.message);
    });
  }, 15000);

  checkInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Auto-update check failed:', err && err.message);
    });
  }, 3600000);
}

/**
 * Manually trigger a check; resolves with a normalized result so the renderer
 * can react immediately without waiting for events to bubble back.
 */
async function triggerManualCheck() {
  state.error = null;
  if (!isAutoUpdateSupported()) {
    const message = 'Updates are only available in packaged builds';
    state.status = 'error';
    state.updateInfo = null;
    state.progress = null;
    state.error = { message };
    safeSend(IPC.UPDATE_ERROR, { message });
    return { supported: false, error: message };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { supported: true };
  } catch (err) {
    const message = (err && err.message) ? err.message : 'Update check failed';
    // Same as the 'error' listener: never clobber a downloaded-and-ready update.
    if (state.status !== 'downloaded') {
      state.status = 'error';
      state.error = { message };
      safeSend(IPC.UPDATE_ERROR, { message });
    }
    return { supported: true, error: message };
  }
}

function setupIPC(_ipcMain) {
  _ipcMain.handle(IPC.CHECK_FOR_UPDATES, async () => {
    return await triggerManualCheck();
  });

  _ipcMain.handle(IPC.GET_UPDATE_STATE, () => {
    return {
      supported: isAutoUpdateSupported(),
      status: state.status,
      updateInfo: state.updateInfo,
      progress: state.progress,
      error: state.error,
      currentVersion: app.getVersion()
    };
  });

  _ipcMain.on(IPC.DOWNLOAD_UPDATE, () => {
    if (!isAutoUpdateSupported()) {
      safeSend(IPC.UPDATE_ERROR, { message: 'Updates are only available in packaged builds' });
      return;
    }
    if (state.status === 'downloaded') {
      // Already downloaded — emit downloaded again so renderer can re-render.
      safeSend(IPC.UPDATE_DOWNLOADED, state.updateInfo);
      return;
    }
    if (!state.updateInfo) {
      safeSend(IPC.UPDATE_ERROR, { message: 'No update is currently available to download' });
      return;
    }
    if (downloadInFlight) return;

    downloadInFlight = true;
    cancellationToken = new CancellationToken();
    state.status = 'downloading';
    state.progress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 };
    safeSend(IPC.UPDATE_DOWNLOAD_PROGRESS, state.progress);

    autoUpdater.downloadUpdate(cancellationToken).catch((err) => {
      // The `error` listener already handles the state cleanup; nothing else
      // to do here. Guard against unhandled rejection noise.
      if (err && err.name !== 'CancellationError') {
        console.error('downloadUpdate failed:', err.message);
      }
    });
  });

  _ipcMain.on(IPC.UPDATE_CANCEL, () => {
    if (cancellationToken && downloadInFlight) {
      cancellationToken.cancel();
    }
  });

  _ipcMain.on(IPC.INSTALL_UPDATE, async () => {
    if (!isAutoUpdateSupported()) {
      safeSend(IPC.UPDATE_ERROR, { message: 'Updates are only available in packaged builds' });
      return;
    }
    if (state.status !== 'downloaded') {
      safeSend(IPC.UPDATE_ERROR, { message: 'No downloaded update is ready to install' });
      return;
    }

    // Squirrel.Mac refuses unsigned/ad-hoc-signed apps, which makes
    // quitAndInstall a silent no-op on our unsigned builds. Replace the app
    // bundle from the downloaded zip ourselves in that case.
    if (process.platform === 'darwin' && !(await isProperlySignedApp())) {
      installMacUpdateManually();
      return;
    }

    installRequested = true;
    autoUpdater.quitAndInstall(false, true);
  });
}

function getAppBundlePath() {
  // .../VibeConsole.app/Contents/MacOS/VibeConsole -> .../VibeConsole.app
  const bundlePath = path.resolve(app.getPath('exe'), '..', '..', '..');
  return bundlePath.endsWith('.app') ? bundlePath : null;
}

async function isProperlySignedApp() {
  const bundlePath = getAppBundlePath();
  if (!bundlePath) return true; // unexpected layout — let Squirrel try
  try {
    // codesign -dv reports "flags=...(adhoc)" for ad-hoc signatures and
    // fails entirely for unsigned bundles; both can't go through Squirrel.
    const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dv', bundlePath]);
    return !/adhoc/i.test(stderr || '');
  } catch {
    return false;
  }
}

const MANUAL_INSTALL_SCRIPT = `#!/bin/sh
PID="$1"; ZIP="$2"; APP="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
EXTRACT=$(mktemp -d) || exit 1
ditto -xk "$ZIP" "$EXTRACT" || exit 1
NEW_APP=$(find "$EXTRACT" -maxdepth 1 -name '*.app' -print | head -n 1)
[ -n "$NEW_APP" ] || exit 1
rm -rf "$APP" || exit 1
mv "$NEW_APP" "$APP" || exit 1
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
rm -rf "$EXTRACT"
rm -f "$0"
open "$APP"
`;

function installMacUpdateManually() {
  try {
    const bundlePath = getAppBundlePath();
    if (!bundlePath || !fs.existsSync(bundlePath)) {
      throw new Error('Could not locate the application bundle');
    }
    if (!downloadedFile || !fs.existsSync(downloadedFile)) {
      throw new Error('Downloaded update file is missing — please download again');
    }

    const scriptPath = path.join(os.tmpdir(), `vibeconsole-update-${process.pid}.sh`);
    fs.writeFileSync(scriptPath, MANUAL_INSTALL_SCRIPT, { mode: 0o700 });

    const child = spawn('/bin/sh', [scriptPath, String(process.pid), downloadedFile, bundlePath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    app.quit();
  } catch (err) {
    safeSend(IPC.UPDATE_ERROR, { message: `Install failed: ${err.message}` });
  }
}

/**
 * Triggered from the main-process menu to open the updater modal in the renderer.
 * The renderer reads the current state via GET_UPDATE_STATE upon receiving this.
 */
function requestOpenModal() {
  safeSend(IPC.OPEN_UPDATER_MODAL);
}

function cleanup() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  if (initialCheckTimeout) {
    clearTimeout(initialCheckTimeout);
    initialCheckTimeout = null;
  }
  if (cancellationToken) {
    try { cancellationToken.cancel(); } catch { /* ignore */ }
    cancellationToken = null;
  }
}

module.exports = { init, setupIPC, cleanup, triggerManualCheck, requestOpenModal };
