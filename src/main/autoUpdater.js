/**
 * Auto Updater Module
 * Uses electron-updater for automatic updates via GitHub Releases.
 */

const { autoUpdater } = require('electron-updater');
const { IPC } = require('../shared/ipcChannels');

let mainWindow = null;
let checkInterval = null;
let initialCheckTimeout = null;
let listenersRegistered = false;

function ensureEventListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  // Event → IPC bridge
  autoUpdater.on('update-available', (info) => {
    send(IPC.UPDATE_AVAILABLE, {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    send(IPC.UPDATE_DOWNLOAD_PROGRESS, { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', () => {
    send(IPC.UPDATE_DOWNLOADED);
  });

  autoUpdater.on('error', (err) => {
    send(IPC.UPDATE_ERROR, { message: err.message });
  });
}

/**
 * Initialize auto updater
 */
function init(window) {
  mainWindow = window;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  ensureEventListeners();

  // Initial check after 15s delay (don't slow startup)
  initialCheckTimeout = setTimeout(() => autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-update check failed:', err.message);
  }), 15000);

  // Periodic check every hour
  checkInterval = setInterval(() => autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-update check failed:', err.message);
  }), 3600000);
}

/**
 * Setup IPC handlers
 */
function setupIPC(_ipcMain) {
  _ipcMain.handle(IPC.CHECK_FOR_UPDATES, () => autoUpdater.checkForUpdates());
  _ipcMain.on(IPC.DOWNLOAD_UPDATE, () => autoUpdater.downloadUpdate());
  _ipcMain.on(IPC.INSTALL_UPDATE, () => autoUpdater.quitAndInstall(false, true));
}

/**
 * Send message to renderer
 */
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/**
 * Cleanup timers
 */
function cleanup() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  if (initialCheckTimeout) {
    clearTimeout(initialCheckTimeout);
    initialCheckTimeout = null;
  }
}

module.exports = { init, setupIPC, cleanup };
