/**
 * Main Process Entry Point
 * Initializes Electron app, creates window, loads modules
 */

// Suppress EPIPE errors on stdout/stderr (occurs when launched from Finder without a TTY)
process.stdout?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { URL, fileURLToPath } = require('url');
const { IPC } = require('../shared/ipcChannels');

// Import modules
const ptyManager = require('./ptyManager');
const menu = require('./menu');
const dialogs = require('./dialogs');
const fileTree = require('./fileTree');
const promptLogger = require('./promptLogger');
const workspace = require('./workspace');
const fileEditor = require('./fileEditor');
const pluginsManager = require('./pluginsManager');
const claudeUsageManager = require('./claudeUsageManager');
const codexUsageManager = require('./codexUsageManager');
const gitBranchesManager = require('./gitBranchesManager');
const gitChangesManager = require('./gitChangesManager');
const aiToolManager = require('./aiToolManager');
const savedPromptsManager = require('./savedPromptsManager');
const autoUpdater = require('./autoUpdater');


let mainWindow = null;

/**
 * Create main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    backgroundColor: '#1e1e1e', // Synced with --terminal-bg in variables.css
    title: 'Vibe Console',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png')
  });

  mainWindow.loadFile('index.html');

  // Prevent untrusted navigations and popup windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedAppUrl(url)) {
      return { action: 'allow' };
    }
    openExternalSafely(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  // Open DevTools only in development mode
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    ptyManager.destroyAll();
    claudeUsageManager.cleanup();
    codexUsageManager.cleanup();
    autoUpdater.cleanup();
    mainWindow = null;
  });

  // Initialize modules with window reference
  ptyManager.init(mainWindow);
  aiToolManager.init(mainWindow, app);
  menu.init(mainWindow, app, aiToolManager);
  dialogs.init(mainWindow, () => {});
  initModulesWithWindow(mainWindow);

  // Create application menu
  menu.createMenu();

  return mainWindow;
}

/**
 * Allow only local app URLs to load inside the app window.
 */
function isTrustedAppUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    const appRoot = path.resolve(__dirname, '..', '..');
    const targetPath = fileURLToPath(parsed);

    if (!fs.existsSync(targetPath)) {
      return false;
    }

    const resolvedRoot = fs.realpathSync(appRoot);
    const resolvedTarget = fs.realpathSync(targetPath);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Open external URLs only for explicitly allowed protocols.
 * Avoid forwarding file/custom scheme URLs to the OS.
 */
function openExternalSafely(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const allowedProtocols = new Set(['https:', 'http:', 'mailto:']);
    if (!allowedProtocols.has(parsed.protocol)) return;
    shell.openExternal(rawUrl).catch(() => {});
  } catch {
    // Ignore malformed URLs
  }
}

/**
 * Setup all IPC handlers
 */
function setupAllIPC() {
  // Setup module IPC handlers
  ptyManager.setupIPC(ipcMain);
  dialogs.setupIPC(ipcMain);
  fileTree.setupIPC(ipcMain);
  promptLogger.setupIPC(ipcMain);
  workspace.setupIPC(ipcMain);
  fileEditor.setupIPC(ipcMain);
  pluginsManager.setupIPC(ipcMain);
  claudeUsageManager.setupIPC(ipcMain);
  codexUsageManager.setupIPC(ipcMain);

  // Generic AI usage routing - routes to correct provider based on toolId
  // Returns cached data immediately if available, then refreshes in background
  ipcMain.on(IPC.LOAD_AI_USAGE, async (event, toolId) => {
    const manager = toolId === 'codex' ? codexUsageManager : claudeUsageManager;
    const cached = manager.getCachedUsage();
    if (cached && !event.sender.isDestroyed()) {
      event.sender.send(IPC.AI_USAGE_DATA, { toolId: toolId || 'claude', ...cached });
    }
    // Always fetch fresh data in background
    const usage = await manager.fetchUsage();
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC.AI_USAGE_DATA, { toolId: toolId || 'claude', ...usage });
    }
  });

  ipcMain.on(IPC.REFRESH_AI_USAGE, async (event, toolId) => {
    if (toolId === 'codex') {
      const usage = await codexUsageManager.fetchUsage();
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.AI_USAGE_DATA, { toolId: 'codex', ...usage });
      }
    } else {
      const usage = await claudeUsageManager.fetchUsage();
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.AI_USAGE_DATA, { toolId: 'claude', ...usage });
      }
    }
  });
  // Open external URLs from renderer (e.g. clickable terminal links)
  ipcMain.on(IPC.OPEN_EXTERNAL_URL, (_event, url) => {
    openExternalSafely(url);
  });

  gitBranchesManager.setupIPC(ipcMain);
  gitChangesManager.setupIPC(ipcMain);
  savedPromptsManager.setupIPC(ipcMain);
  autoUpdater.setupIPC(ipcMain);
}

/**
 * Initialize application
 */
function init() {
  // Initialize prompt logger with app paths
  promptLogger.init(app);

  // Setup IPC handlers
  setupAllIPC();
}

/**
 * Initialize modules that need window reference
 */
function initModulesWithWindow(window) {
  workspace.init(app, window);
  fileEditor.init(window);
  pluginsManager.init(window);
  claudeUsageManager.init(window);
  codexUsageManager.init(window);
  gitBranchesManager.init(window);
  gitChangesManager.init(window);
  savedPromptsManager.init(window);
  autoUpdater.init(window);
}

// App lifecycle
app.whenReady().then(() => {
  app.setName('Vibe Console');

  init();
  createWindow();
});

app.on('before-quit', () => {
  ptyManager.destroyAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

module.exports = { createWindow };
