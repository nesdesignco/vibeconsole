/**
 * File Tree Module
 * Generates directory tree structure
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const { isPathWithinProject } = require('../shared/pathValidation');

/**
 * Get file tree for a directory
 * @param {string} dirPath - Directory path
 * @param {number} maxDepth - Maximum depth to traverse
 * @param {number} currentDepth - Current depth level
 * @returns {Array} File tree structure
 */
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
  if (!sender.isDestroyed()) sender.send(channel, data);
}

function setupIPC(ipcMain) {
  ipcMain.on(IPC.LOAD_FILE_TREE, (event, projectPath) => {
    const files = getFileTree(projectPath);
    safeSend(event.sender, IPC.FILE_TREE_DATA, files);
  });

  ipcMain.on(IPC.CREATE_FILE, (event, { filePath, projectPath }) => {
    try {
      if (!projectPath || !isPathWithinProject(filePath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath, error: 'Path is outside project directory' });
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
      if (!projectPath || !isPathWithinProject(folderPath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: folderPath, error: 'Path is outside project directory' });
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
      if (!projectPath || !isPathWithinProject(oldPath, projectPath) || !isPathWithinProject(newPath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath: oldPath, error: 'Path is outside project directory' });
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
    if (!projectPath || !isPathWithinProject(filePath, projectPath)) return;
    shell.showItemInFolder(filePath);
  });

  ipcMain.on(IPC.DELETE_FILE, async (event, { filePath, projectPath }) => {
    try {
      if (!projectPath || !isPathWithinProject(filePath, projectPath)) {
        safeSend(event.sender, IPC.FILE_DELETED, { success: false, filePath, error: 'Path is outside project directory' });
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
  setupIPC
};
