/**
 * Auto Updater Module
 * Uses electron-updater for automatic updates via GitHub Releases.
 */

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { IPC } = require('../shared/ipcChannels');

let mainWindow = null;
let checkInterval = null;
let initialCheckTimeout = null;
let listenersRegistered = false;
let updateAvailableInfo = null;
let updateReady = false;

function isAutoUpdateSupported() {
  return app.isPackaged === true;
}

function sendUpdateError(message) {
  send(IPC.UPDATE_ERROR, { message });
}

function ensureEventListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  // Event → IPC bridge
  autoUpdater.on('update-available', (info) => {
    updateAvailableInfo = {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    };
    updateReady = false;
    send(IPC.UPDATE_AVAILABLE, {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    send(IPC.UPDATE_DOWNLOAD_PROGRESS, { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    send(IPC.UPDATE_DOWNLOADED);
  });

  autoUpdater.on('error', (err) => {
    if (!updateReady) {
      updateAvailableInfo = null;
    }
    send(IPC.UPDATE_ERROR, { message: err.message });
  });
}

/**
 * Initialize auto updater
 */
function init(window) {
  mainWindow = window;

  if (!isAutoUpdateSupported()) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
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
  _ipcMain.handle(IPC.CHECK_FOR_UPDATES, () => {
    if (!isAutoUpdateSupported()) {
      return { skipped: true, reason: 'updates-disabled-in-development' };
    }
    return autoUpdater.checkForUpdates();
  });

  _ipcMain.on(IPC.DOWNLOAD_UPDATE, () => {
    if (!isAutoUpdateSupported()) {
      sendUpdateError('Updates are only available in packaged builds');
      return;
    }
    if (!updateAvailableInfo || updateReady) {
      sendUpdateError('No update is currently available to download');
      return;
    }
    autoUpdater.downloadUpdate().catch((err) => {
      sendUpdateError(err.message);
    });
  });

  _ipcMain.on(IPC.INSTALL_UPDATE, () => {
    if (!isAutoUpdateSupported()) {
      sendUpdateError('Updates are only available in packaged builds');
      return;
    }
    if (!updateReady) {
      sendUpdateError('No downloaded update is ready to install');
      return;
    }
    autoUpdater.quitAndInstall(false, true);
  });
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
  updateAvailableInfo = null;
  updateReady = false;
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
