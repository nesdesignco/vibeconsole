/**
 * File Editor Module
 * Handles file reading and writing for the editor overlay
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { IPC } = require('../shared/ipcChannels');
const { isPathWithinProject } = require('../shared/pathValidation');
const MAX_EDITOR_FILE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Initialize file editor module
 */
function init(_window) {
  // Window reference reserved for future use
}

/**
 * Read file contents
 */
async function readFile(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    if (stats.size > MAX_EDITOR_FILE_BYTES) {
      return {
        success: false,
        error: `File too large to open (max ${Math.floor(MAX_EDITOR_FILE_BYTES / (1024 * 1024))}MB)`,
        filePath
      };
    }

    const content = await fsp.readFile(filePath, 'utf8');
    return { success: true, content, filePath };
  } catch (err) {
    return { success: false, error: err.message, filePath };
  }
}

/**
 * Write file contents
 */
async function writeFile(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.writeFile(tempPath, content, 'utf8');
    await fsp.rename(tempPath, filePath);
    return { success: true, filePath };
  } catch (err) {
    try {
      await fsp.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    return { success: false, error: err.message, filePath };
  }
}

/**
 * Get file extension
 */
function getFileExtension(filePath) {
  return path.extname(filePath).toLowerCase().slice(1);
}

function safeSend(sender, channel, data) {
  if (!sender.isDestroyed()) sender.send(channel, data);
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  ipcMain.on(IPC.READ_FILE, async (event, { filePath, projectPath }) => {
    if (!projectPath || !isPathWithinProject(filePath, projectPath)) {
      safeSend(event.sender, IPC.FILE_CONTENT, { success: false, error: 'Path is outside project directory', filePath });
      return;
    }
    const result = await readFile(filePath);
    result.extension = getFileExtension(filePath);
    result.fileName = path.basename(filePath);
    safeSend(event.sender, IPC.FILE_CONTENT, result);
  });

  ipcMain.on(IPC.WRITE_FILE, async (event, { filePath, content, projectPath }) => {
    if (!projectPath || !isPathWithinProject(filePath, projectPath)) {
      safeSend(event.sender, IPC.FILE_SAVED, { success: false, error: 'Path is outside project directory', filePath });
      return;
    }
    if (Buffer.byteLength(content || '', 'utf8') > MAX_EDITOR_FILE_BYTES) {
      safeSend(event.sender, IPC.FILE_SAVED, { success: false, error: `File too large to save (max ${Math.floor(MAX_EDITOR_FILE_BYTES / (1024 * 1024))}MB)`, filePath });
      return;
    }
    const result = await writeFile(filePath, content);
    safeSend(event.sender, IPC.FILE_SAVED, result);
  });
}

module.exports = {
  init,
  readFile,
  writeFile,
  setupIPC
};
