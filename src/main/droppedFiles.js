/**
 * Dropped Files Module
 * Materializes drag-and-drop payloads that have no filesystem path
 * (in-memory images, browser drags, data URLs) into temp files so the
 * terminal can always paste a usable path.
 */

const fs = require('fs');
const fsp = fs.promises;
const dns = require('node:dns');
const nodeNet = require('node:net');
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

/**
 * True for addresses a drag-and-drop download must never reach:
 * loopback, RFC1918 private ranges, link-local (incl. cloud metadata),
 * unspecified, and multicast/reserved space.
 */
function isPrivateAddress(ip) {
  if (nodeNet.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return lower === '::' || lower === '::1' ||
    lower.startsWith('fe8') || lower.startsWith('fe9') ||
    lower.startsWith('fea') || lower.startsWith('feb') ||
    lower.startsWith('fc') || lower.startsWith('fd') ||
    lower.startsWith('ff');
}

/**
 * Reject URLs whose host is (or resolves to) a private/internal address.
 * Applied to the initial URL and every redirect hop (SSRF hardening).
 */
async function assertPublicHttpUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Blocked host');
  }
  if (nodeNet.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Blocked host');
    return;
  }
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some(r => isPrivateAddress(r.address))) {
    throw new Error('Blocked host');
  }
}

const MAX_REDIRECTS = 5;

/**
 * Issue a single non-following request. Resolves with either
 * { redirectUrl } (3xx, request aborted) or { buffer, contentType } (2xx).
 * Electron requires followRedirect() to be called synchronously inside the
 * redirect event, which precludes async host validation — so redirects are
 * surfaced to the caller and re-requested after validation instead.
 */
function fetchOneHop(currentUrl, deadline) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: currentUrl, redirect: 'manual' });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (err) => {
      settle(reject, err);
      request.abort();
    };
    const timer = setTimeout(() => fail(new Error('Download timed out')), Math.max(0, deadline - Date.now()));
    request.on('redirect', (statusCode, method, redirectUrl) => {
      settle(resolve, { redirectUrl });
      request.abort();
    });
    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return fail(new Error(`Download failed (HTTP ${response.statusCode})`));
      }
      const rawType = response.headers['content-type'];
      const contentType = Array.isArray(rawType) ? rawType[0] : rawType;
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) return fail(new Error('Download too large'));
        chunks.push(chunk);
      });
      response.on('end', () => settle(resolve, { buffer: Buffer.concat(chunks), contentType }));
      response.on('error', fail);
    });
    request.on('error', (err) => settle(reject, err));
    request.end();
  });
}

async function downloadUrlToTemp(url) {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'Only http(s) URLs are supported' };
    }
    // Redirects are not followed in-request: each hop aborts, re-validates
    // the target against private-host rules, then issues a fresh request.
    // A public URL therefore cannot bounce us into localhost or the LAN.
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    let currentUrl = url;
    let download = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHttpUrl(currentUrl);
      const result = await fetchOneHop(currentUrl, deadline);
      if (result.redirectUrl) {
        currentUrl = new URL(result.redirectUrl, currentUrl).toString();
        continue;
      }
      download = result;
      break;
    }
    if (!download) return { success: false, error: 'Too many redirects' };
    if (download.buffer.length === 0) return { success: false, error: 'Empty download' };
    const dir = await createDropDir();
    const filePath = path.join(dir, filenameFromUrl(currentUrl, download.contentType));
    await fsp.writeFile(filePath, download.buffer);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function setupIPC(ipcMain) {
  ipcMain.handle(IPC.SAVE_DROPPED_FILE, (event, payload) => saveDroppedFile(payload || {}));
  ipcMain.handle(IPC.DOWNLOAD_URL_TO_TEMP, (event, url) => downloadUrlToTemp(url));
}

module.exports = { setupIPC, sanitizeFilename, filenameFromUrl, isPrivateAddress, assertPublicHttpUrl };
