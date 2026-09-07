/**
 * File Tree Module
 * Generates directory tree structure
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const { isPathWithinProjectContent, isKnownProjectRoot } = require('./projectAccess');
const watcherBySenderId = new Map(); // Map<number, { watcher: fs.FSWatcher, projectPath: string, timer: NodeJS.Timeout | null }>
const PROJECT_PATH_ERROR = 'Path is outside project directory or targets protected metadata';

/**
 * Get file tree for a directory
 * @param {string} dirPath - Directory path
 * @param {number} maxDepth - Maximum depth to traverse
 * @param {number} currentDepth - Current depth level
 * @returns {Array} File tree structure
 */
// Directories excluded from the tree, and therefore from watch events too.
const IGNORED_WATCH_SEGMENTS = new Set(['node_modules', '.git']);

/**
 * True when a watcher-reported path lies inside a directory the tree excludes.
 * @param {string} filename path relative to the watched root, as fs.watch reports it
 */
function isIgnoredWatchPath(filename) {
  const segments = String(filename).split(/[/\\]/);
  // The last segment is the entry itself; a change to a directory *named*
  // node_modules still matters only for its contents, which are excluded too.
  return segments.some(segment => IGNORED_WATCH_SEGMENTS.has(segment));
}

function getFileTree(dirPath, maxDepth = 5, currentDepth = 0, visitedPaths = null) {
  if (currentDepth >= maxDepth) return [];

  // Track visited real paths to prevent symlink loops
  if (!visitedPaths) visitedPaths = new Set();

  try {
    const realDir = fs.realpathSync(dirPath);
    if (visitedPaths.has(realDir)) return []; // Symlink cycle detected
    visitedPaths.add(realDir);

    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];

    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const item of items) {
      // Show dotfiles (e.g. .env, .gitignore). Keep excluding heavy/noisy directories.
      if (item.name === 'node_modules') continue;
      if (item.isDirectory() && item.name === '.git') continue;

      const fullPath = path.join(dirPath, item.name);
      const fileInfo = {
        name: item.name,
        path: fullPath,
        isDirectory: item.isDirectory()
      };

      // Recursively get children for directories
      if (item.isDirectory()) {
        fileInfo.children = getFileTree(fullPath, maxDepth, currentDepth + 1, visitedPaths);
      }

      files.push(fileInfo);
    }

    return files;
  } catch (err) {
    console.error('Error reading directory:', err);
    return [];
  }
}

/**
 * Setup IPC handlers
 */
function safeSend(sender, channel, data) {
  if (!sender || typeof sender.send !== 'function') return;
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return;
  sender.send(channel, data);
}

function stopWatcherForSender(senderId) {
  const entry = watcherBySenderId.get(senderId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch (err) {
    console.error('Failed to close file tree watcher:', err);
  }
  watcherBySenderId.delete(senderId);
}

function startWatcherForSender(sender, projectPath) {
  if (!sender || typeof sender.id !== 'number') return;
  const senderId = sender.id;
  stopWatcherForSender(senderId);

  if (!projectPath || !fs.existsSync(projectPath)) return;
  let stat;
  try {
    stat = fs.statSync(projectPath);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  let timer = null;
  const scheduleRefresh = (_eventType, filename) => {
    // getFileTree never returns node_modules or .git, so churn inside them
    // (npm install, git checkout) would rebuild and re-send a tree that cannot
    // have changed — and the renderer rebuilds its DOM for every message.
    // A null filename means the platform did not tell us what changed; refresh.
    if (filename && isIgnoredWatchPath(filename)) return;
    if (timer) clearTimeout(timer);
    const prevEntry = watcherBySenderId.get(senderId);
    if (prevEntry) prevEntry.timer = null;
    timer = setTimeout(() => {
      timer = null;
      const current = watcherBySenderId.get(senderId);
      if (!current || current.projectPath !== projectPath) return;
      current.timer = null;
      const files = getFileTree(projectPath);
      safeSend(sender, IPC.FILE_TREE_DATA, files);
    }, 120);
    const current = watcherBySenderId.get(senderId);
    if (current) current.timer = timer;
  };

  try {
    let watcher;
    try {
      watcher = fs.watch(projectPath, { recursive: true }, scheduleRefresh);
    } catch (err) {
      if (err && err.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        watcher = fs.watch(projectPath, scheduleRefresh);
      } else {
        throw err;
      }
    }

    watcher.on('error', (err) => {
      console.error('File tree watcher error:', err);
    });

    watcherBySenderId.set(senderId, { watcher, projectPath, timer });

    if (typeof sender.once === 'function') {
      sender.once('destroyed', () => {
        stopWatcherForSender(senderId);
      });
    }
  } catch (err) {
    console.error('Failed to start file tree watcher:', err);
  }
}

function setupIPC(ipcMain) {
  ipcMain.handle(IPC.LOAD_FILE_TREE, (event, projectPath) => {
    if (!isKnownProjectRoot(projectPath)) throw new Error('Select a project before refreshing its files.');
    fs.accessSync(projectPath, fs.constants.R_OK);
    return getFileTree(projectPath);
  });
  ipcMain.on(IPC.LOAD_FILE_TREE, (event, projectPath) => {
    // Without this the renderer could enumerate any directory on disk.
    if (!isKnownProjectRoot(projectPath)) {
      safeSend(event.sender, IPC.FILE_TREE_DATA, []);
      return;
    }
    const files = getFileTree(projectPath);
    safeSend(event.sender, IPC.FILE_TREE_DATA, files);
  });

  ipcMain.on(IPC.START_FILE_TREE_WATCH, (event, projectPath) => {
    if (!isKnownProjectRoot(projectPath)) return;
    startWatcherForSender(event.sender, projectPath);
  });

  ipcMain.on(IPC.STOP_FILE_TREE_WATCH, (event) => {
    stopWatcherForSender(event.sender.id);
  });

  ipcMain.on(IPC.CREATE_FILE, (event, { filePath, projectPath }) => {
    try {
      if (!projectPath || !isPathWithinProjectContent(filePath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath, error: PROJECT_PATH_ERROR });
        return;
      }
      if (fs.existsSync(filePath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath, error: 'File already exists' });
        return;
      }
      fs.writeFileSync(filePath, '');
      if (projectPath) {
        const files = getFileTree(projectPath);
        safeSend(event.sender, IPC.FILE_TREE_DATA, files);
      }
    } catch (err) {
      console.error('Error creating file:', err);
      safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath, error: err.message });
    }
  });

  ipcMain.on(IPC.CREATE_FOLDER, (event, { folderPath, projectPath }) => {
    try {
      if (!projectPath || !isPathWithinProjectContent(folderPath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: folderPath, error: PROJECT_PATH_ERROR });
        return;
      }
      if (fs.existsSync(folderPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: folderPath, error: 'Folder already exists' });
        return;
      }
      fs.mkdirSync(folderPath, { recursive: true });
      if (projectPath) {
        const files = getFileTree(projectPath);
        safeSend(event.sender, IPC.FILE_TREE_DATA, files);
      }
    } catch (err) {
      console.error('Error creating folder:', err);
      safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: folderPath, error: err.message });
    }
  });

  ipcMain.on(IPC.RENAME_FILE, (event, { oldPath, newPath, projectPath }) => {
    try {
      if (!projectPath || !isPathWithinProjectContent(oldPath, projectPath) || !isPathWithinProjectContent(newPath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: oldPath, error: PROJECT_PATH_ERROR });
        return;
      }
      if (fs.existsSync(newPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: oldPath, error: 'A file with that name already exists' });
        return;
      }
      fs.renameSync(oldPath, newPath);
      if (projectPath) {
        const files = getFileTree(projectPath);
        safeSend(event.sender, IPC.FILE_TREE_DATA, files);
      }
    } catch (err) {
      console.error('Error renaming file:', err);
      safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: oldPath, error: err.message });
    }
  });

  ipcMain.on(IPC.REVEAL_IN_FINDER, (event, { filePath, projectPath }) => {
    if (!projectPath || !isPathWithinProjectContent(filePath, projectPath)) return;
    shell.showItemInFolder(filePath);
  });

  ipcMain.on(IPC.DELETE_FILE, async (event, { filePath, projectPath }) => {
    try {
      if (!projectPath || !isPathWithinProjectContent(filePath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath, error: PROJECT_PATH_ERROR });
        return;
      }
      await shell.trashItem(filePath);
      safeSend(event.sender, IPC.FILE_DELETED, { success: true, filePath });
      // Auto-refresh file tree
      if (projectPath) {
        const files = getFileTree(projectPath);
        safeSend(event.sender, IPC.FILE_TREE_DATA, files);
      }
    } catch (err) {
      console.error('Error deleting file:', err);
      safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath, error: err.message });
    }
  });
}

module.exports = {
  getFileTree,
  isIgnoredWatchPath,
  setupIPC
};
