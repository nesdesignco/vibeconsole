/**
 * Dropped Files Module
 * Materializes drag-and-drop payloads that have no filesystem path
 * (in-memory images, browser drags, data URLs) into temp files so the
 * terminal can always paste a usable path.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { net } = require('electron');
const { IPC } = require('../shared/ipcChannels');

const MAX_DROPPED_FILE_BYTES = 200 * 1024 * 1024; // 200MB
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const TEMP_DIR_NAME = 'vibeconsole-drops';

// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = new RegExp("[\\u0000-\\u001f/\\\\:*?\"<>|]", "g");

const EXTENSION_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/avif': '.avif',
  'application/pdf': '.pdf'
};

/**
 * Reduce an arbitrary name to a safe basename (no separators, no control
 * characters, bounded length) while keeping the original extension visible.
 */
function sanitizeFilename(name, fallback = 'dropped-file') {
  const base = path.basename(String(name || ''));
  const cleaned = base.replace(UNSAFE_FILENAME_CHARS, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  if (cleaned.length <= 128) return cleaned;
  const ext = path.extname(cleaned).slice(0, 16);
  return cleaned.slice(0, 128 - ext.length) + ext;
}

/**
 * Create a unique directory under the OS temp dir for one drop operation.
 * A per-drop directory keeps the original filename intact without collisions.
 */
async function createDropDir() {
  const base = path.join(os.tmpdir(), TEMP_DIR_NAME);
  await fsp.mkdir(base, { recursive: true });
  return fsp.mkdtemp(path.join(base, 'drop-'));
}

async function saveDroppedFile({ name, data }) {
  try {
    if (!data) return { success: false, error: 'No data' };
    const buffer = ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data);
    if (buffer.length === 0) return { success: false, error: 'Empty file' };
    if (buffer.length > MAX_DROPPED_FILE_BYTES) {
      return { success: false, error: 'Dropped file too large' };
    }
    const dir = await createDropDir();
    const filePath = path.join(dir, sanitizeFilename(name));
    await fsp.writeFile(filePath, buffer);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function filenameFromUrl(url, contentType) {
  let name;
  try {
    name = decodeURIComponent(path.posix.basename(new URL(url).pathname));
  } catch {
    name = '';
  }
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EXTENSION_BY_MIME[mime];
  if (!name) name = 'download';
  if (ext && !name.toLowerCase().endsWith(ext)) {
    name = path.extname(name) ? name : name + ext;
  }
  return sanitizeFilename(name, 'download');
}

async function downloadUrlToTemp(url) {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'Only http(s) URLs are supported' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await net.fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return { success: false, error: `Download failed (HTTP ${response.status})` };
      }
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          controller.abort();
          return { success: false, error: 'Download too large' };
        }
        chunks.push(Buffer.from(value));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) return { success: false, error: 'Empty download' };
      const dir = await createDropDir();
      const filePath = path.join(dir, filenameFromUrl(url, response.headers.get('content-type')));
      await fsp.writeFile(filePath, buffer);
      return { success: true, path: filePath };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'Download timed out' : err.message };
  }
}

function setupIPC(ipcMain) {
  ipcMain.handle(IPC.SAVE_DROPPED_FILE, (event, payload) => saveDroppedFile(payload || {}));
  ipcMain.handle(IPC.DOWNLOAD_URL_TO_TEMP, (event, url) => downloadUrlToTemp(url));
}

module.exports = { setupIPC, sanitizeFilename, filenameFromUrl };
