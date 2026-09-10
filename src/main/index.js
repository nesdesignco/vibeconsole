/**
 * Main Process Entry Point
 * Initializes Electron app, creates window, loads modules
 */

// Suppress EPIPE errors on stdout/stderr (occurs when launched from Finder without a TTY)
process.stdout?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

const { app, BrowserWindow, ipcMain, shell } = require('electron');

// Isolated profile for test/dev instances: a dev launch must never share
// userData (session storage) with a running installed app.
if (process.env.VIBE_USER_DATA_DIR) {
  app.setPath('userData', process.env.VIBE_USER_DATA_DIR);
}
const path = require('path');
const fs = require('fs');
const { URL, fileURLToPath } = require('url');
const { IPC } = require('../shared/ipcChannels');
const { normalizeTerminalUrl } = require('../shared/urlUtils');

// Import modules
const ptyManager = require('./ptyManager');
const menu = require('./menu');
const dialogs = require('./dialogs');
const projectAccess = require('./projectAccess');
const fileTree = require('./fileTree');
const promptLogger = require('./promptLogger');
const workspace = require('./workspace');
const fileEditor = require('./fileEditor');
const droppedFiles = require('./droppedFiles');
const skillsManager = require('./skillsManager');
const computerUse = require('./computerUse');
const claudeUsageManager = require('./claudeUsageManager');
const codexUsageManager = require('./codexUsageManager');
const gitBranchesManager = require('./gitBranchesManager');
const gitChangesManager = require('./gitChangesManager');
const aiToolManager = require('./aiToolManager');
const aiToolProcessDetector = require('./aiToolProcessDetector');
const savedPromptsManager = require('./savedPromptsManager');
const autoUpdater = require('./autoUpdater');
const projectContext = require('./projectContext');
const appearance = require('./appearance');
const { variables } = require('../shared/appearance');


let mainWindow = null;

/**
 * Create main application window
 */
function createWindow() {
  const { nativeTheme } = require('electron');
  const appearanceState = appearance.load();
  const savedAppearance = appearanceState.settings;
  nativeTheme.themeSource = savedAppearance.mode;
  mainWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 850,
    webPreferences: {
      additionalArguments: [`--vibe-appearance=${JSON.stringify(appearanceState)}`],
      preload: path.join(__dirname, '..', '..', 'dist', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    backgroundColor: variables(savedAppearance, nativeTheme.shouldUseDarkColors).values['bg-primary'],
    title: 'Vibe Console',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png')
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

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

  // Smoke test hook: report renderer load result and exit (used by test/smoke.js)
  if (process.env.VIBE_SMOKE === '1') {
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('VIBE_SMOKE_OK');
      app.exit(0);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('VIBE_SMOKE_FAIL', code, desc);
      app.exit(1);
    });
  }

  mainWindow.on('closed', () => {
    ptyManager.destroyAll();
    aiToolProcessDetector.cleanup();
    claudeUsageManager.cleanup();
    codexUsageManager.cleanup();
    autoUpdater.cleanup();
    mainWindow = null;
  });

  // Initialize modules with window reference
  ptyManager.init(mainWindow);
  aiToolProcessDetector.init(mainWindow);
  aiToolManager.init(mainWindow, app, () => menu.createMenu());
  menu.init(mainWindow, app, aiToolManager);
  // The picked folder is the authoritative moment a project root comes into
  // existence; record it before the renderer can act on it.
  dialogs.init(mainWindow, (projectPath) => projectAccess.registerProjectRoot(projectPath));
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
  // Defense in depth: normalize here too so protocol-less URLs from any
  // caller (older renderers, window handlers) still open, and log every
  // drop/failure — silent failures made this chain undiagnosable for months.
  const normalized = normalizeTerminalUrl(rawUrl);
  if (!normalized) {
    console.warn('[external-url] dropped (empty):', rawUrl);
    return;
  }
  try {
    const parsed = new URL(normalized);
    const allowedProtocols = new Set(['https:', 'http:', 'mailto:']);
    if (!allowedProtocols.has(parsed.protocol)) {
      console.warn('[external-url] dropped (protocol not allowed):', rawUrl);
      return;
    }
    shell.openExternal(normalized).catch((err) => {
      console.error('[external-url] openExternal failed:', normalized, err);
    });
  } catch (err) {
    console.warn('[external-url] dropped (malformed):', rawUrl, err?.message);
  }
}

/**
 * Setup all IPC handlers
 */
function setupAllIPC() {
  appearance.setupIPC(ipcMain);
  // Setup module IPC handlers
  ptyManager.setupIPC(ipcMain);
  dialogs.setupIPC(ipcMain);
  fileTree.setupIPC(ipcMain);
  promptLogger.setupIPC(ipcMain);
  workspace.setupIPC(ipcMain);
  fileEditor.setupIPC(ipcMain);
  droppedFiles.setupIPC(ipcMain);
  skillsManager.setupIPC(ipcMain);
  computerUse.setupIPC(ipcMain);
  claudeUsageManager.setupIPC(ipcMain);
  codexUsageManager.setupIPC(ipcMain);

  // Generic AI usage routing - routes to correct provider based on toolId
  // Returns cached data immediately if available, then refreshes in background
  const usageManagers = { claude: claudeUsageManager, codex: codexUsageManager };
  ipcMain.on(IPC.LOAD_AI_USAGE, async (event, toolId = 'claude') => {
    try {
      const manager = Object.hasOwn(usageManagers, toolId) ? usageManagers[toolId] : null;
      if (!manager) return;
      const cached = manager.getCachedUsage();
      if (cached && !event.sender.isDestroyed()) {
        event.sender.send(IPC.AI_USAGE_DATA, { toolId, ...cached });
      }
      // Always fetch fresh data in background
      const usage = await manager.fetchUsage();
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.AI_USAGE_DATA, { toolId, ...usage });
      }
    } catch (err) {
      console.error('LOAD_AI_USAGE failed:', err);
    }
  });

  ipcMain.on(IPC.REFRESH_AI_USAGE, async (event, toolId = 'claude') => {
    try {
      const manager = Object.hasOwn(usageManagers, toolId) ? usageManagers[toolId] : null;
      if (!manager) return;
      const usage = await manager.fetchUsage();
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.AI_USAGE_DATA, { toolId, ...usage });
      }
    } catch (err) {
      console.error('REFRESH_AI_USAGE failed:', err);
    }
  });
  // Open external URLs from renderer (e.g. clickable terminal links)
  ipcMain.on(IPC.OPEN_EXTERNAL_URL, (_event, url) => {
    openExternalSafely(url);
  });

  gitBranchesManager.setupIPC(ipcMain);
  gitChangesManager.setupIPC(ipcMain);
  savedPromptsManager.setupIPC(ipcMain);
  projectContext.setupIPC(ipcMain);
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
