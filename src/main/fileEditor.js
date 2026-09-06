/**
 * File Editor Module
 * Handles file reading and writing for the editor overlay
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('node:crypto');
const pendingWrites = new Map();
const { IPC } = require('../shared/ipcChannels');
const { isPathWithinProjectContent } = require('./projectAccess');
const MAX_EDITOR_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const PROJECT_PATH_ERROR = 'Path is outside project directory or targets protected metadata';

function getMimeTypeForExtension(extension) {
  switch ((extension || '').toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'ico': return 'image/x-icon';
    case 'svg': return 'image/svg+xml';
    default: return null;
  }
}

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

async function readFileAsDataUrl(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    if (stats.size > MAX_EDITOR_FILE_BYTES) {
      return {
        success: false,
        error: `File too large to open (max ${Math.floor(MAX_EDITOR_FILE_BYTES / (1024 * 1024))}MB)`,
        filePath
      };
    }

    const extension = getFileExtension(filePath);
    const mime = getMimeTypeForExtension(extension);
    if (!mime) {
      return { success: false, error: 'Unsupported preview type', filePath };
    }

    const buffer = await fsp.readFile(filePath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return {
      success: true,
      dataUrl,
      mime,
      sizeBytes: buffer.length,
      filePath
    };
  } catch (err) {
    return { success: false, error: err.message, filePath };
  }
}

/**
 * Write file contents
 */
function writeFile(filePath, content, projectPath) {
  let targetPath;
  try {
    // Resolve before queueing so aliases of the same file share write order.
    // An editor save requires an existing target; dangling links must not be replaced.
    targetPath = fs.realpathSync(filePath);
    if (projectPath && !isPathWithinProjectContent(targetPath, projectPath)) {
      return Promise.resolve({ success: false, error: PROJECT_PATH_ERROR, filePath });
    }
  } catch (err) {
    return Promise.resolve({ success: false, error: err.message, filePath });
  }
  const previous = pendingWrites.get(targetPath) || Promise.resolve();
  const pending = previous.then(() => replaceFile(targetPath, filePath, content, projectPath));
  pendingWrites.set(targetPath, pending);
  return pending.finally(() => {
    if (pendingWrites.get(targetPath) === pending) pendingWrites.delete(targetPath);
  });
}

async function replaceFile(targetPath, filePath, content, projectPath) {
  let handle;
  let ownsTemp = false;
  const tempPath = path.join(path.dirname(targetPath), `.vibe-save-${randomUUID()}`);
  try {
    if (projectPath && (!isPathWithinProjectContent(targetPath, projectPath) ||
        !isPathWithinProjectContent(filePath, projectPath))) {
      throw new Error(PROJECT_PATH_ERROR);
    }
    if (await fsp.realpath(filePath) !== targetPath) throw new Error('File target changed; reopen it before saving');
    const stats = await fsp.stat(targetPath);
    handle = await fsp.open(tempPath, 'wx', 0o600);
    ownsTemp = true;
    await handle.writeFile(content, 'utf8');
    await handle.chmod(stats.mode & 0o7777);
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, targetPath);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message, filePath };
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (ownsTemp) await fsp.unlink(tempPath).catch(() => {});
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
  ipcMain.on(IPC.READ_FILE, async (event, { filePath, projectPath, requestId }) => {
    if (!projectPath || !isPathWithinProjectContent(filePath, projectPath)) {
      safeSend(event.sender, IPC.FILE_CONTENT, { success: false, error: PROJECT_PATH_ERROR, filePath, requestId });
      return;
    }
    const result = await readFile(filePath);
    result.requestId = requestId;
    result.extension = getFileExtension(filePath);
    result.fileName = path.basename(filePath);
    safeSend(event.sender, IPC.FILE_CONTENT, result);
  });

  ipcMain.on(IPC.READ_FILE_DATA_URL, async (event, { filePath, projectPath, requestId }) => {
    if (!projectPath || !isPathWithinProjectContent(filePath, projectPath)) {
      safeSend(event.sender, IPC.FILE_DATA_URL, { success: false, error: PROJECT_PATH_ERROR, filePath, requestId });
      return;
    }
    const result = await readFileAsDataUrl(filePath);
    result.requestId = requestId;
    result.extension = getFileExtension(filePath);
    result.fileName = path.basename(filePath);
    safeSend(event.sender, IPC.FILE_DATA_URL, result);
  });

  ipcMain.on(IPC.WRITE_FILE, async (event, { filePath, content, projectPath, requestId }) => {
    if (!projectPath || !isPathWithinProjectContent(filePath, projectPath)) {
      safeSend(event.sender, IPC.FILE_SAVED, { success: false, error: PROJECT_PATH_ERROR, filePath, requestId });
      return;
    }
    if (typeof content !== 'string') {
      safeSend(event.sender, IPC.FILE_SAVED, { success: false, error: 'Invalid file content', filePath, requestId });
      return;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_EDITOR_FILE_BYTES) {
      safeSend(event.sender, IPC.FILE_SAVED, { success: false, error: `File too large to save (max ${Math.floor(MAX_EDITOR_FILE_BYTES / (1024 * 1024))}MB)`, filePath, requestId });
      return;
    }
    const result = await writeFile(filePath, content, projectPath);
    result.requestId = requestId;
    safeSend(event.sender, IPC.FILE_SAVED, result);
  });
}

module.exports = {
  init,
  readFile,
  readFileAsDataUrl,
  writeFile,
  setupIPC
};
