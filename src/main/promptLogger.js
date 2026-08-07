/**
 * Prompt Logger Module
 * Logs terminal input to history file
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { IPC } = require('../shared/ipcChannels');

let logFilePath = null;
const inputBuffers = new Map(); // Map<terminalId, inputBuffer>
const keyBlockMode = new Map(); // Map<terminalId, boolean>
let writeQueue = Promise.resolve();

// Bounds for what the history panel loads. The log itself is never truncated.
const MAX_HISTORY_READ_BYTES = 1024 * 1024;
const MAX_HISTORY_LINES = 5000;

/**
 * Initialize prompt logger
 */
function init(app) {
  logFilePath = path.join(app.getPath('userData'), 'prompts-history.txt');
}

/**
 * Get log file path
 */
function getLogFilePath() {
  return logFilePath;
}

function enqueueLogWrite(logEntry) {
  if (!logFilePath) return;
  if (process.env.VIBECONSOLE_DISABLE_PROMPT_HISTORY === '1') return;
  writeQueue = writeQueue
    .then(() => fsp.appendFile(logFilePath, logEntry, 'utf8'))
    .catch((err) => {
      console.error('Error writing prompt history:', err);
    });
}

function sanitizeHistoryLine(line, terminalId = 'global') {
  const key = terminalId || 'global';
  const raw = String(line ?? '');

  // If a private key block is pasted, redact the whole block line-by-line until END marker.
  const beginKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
  const endKey = /-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
  const inKeyBlock = Boolean(keyBlockMode.get(key));

  if (beginKey.test(raw)) {
    keyBlockMode.set(key, true);
    return '[REDACTED: PRIVATE KEY BLOCK]';
  }

  if (inKeyBlock) {
    if (endKey.test(raw)) {
      keyBlockMode.set(key, false);
    }
    return '[REDACTED: PRIVATE KEY BLOCK]';
  }

  let out = raw;

  // Common explicit auth header patterns.
  out = out.replace(/\bAuthorization\b\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Authorization: Bearer [REDACTED]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g, 'Bearer [REDACTED]');

  // Key/value-ish patterns (keep the key, redact only the value).
  out = out.replace(
    /\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*([^\s'"]{6,})/gi,
    (m, k) => `${k}=[REDACTED]`
  );

  // Known token formats/prefixes.
  out = out.replace(/\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
  out = out.replace(/\bghp_[A-Za-z0-9]{30,}\b/g, '[REDACTED]');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]');
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]');
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');

  // JWT (very common).
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');

  // SSH public key lines (still sensitive in some contexts; avoid persisting them).
  out = out.replace(/\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/=]{50,}(?:\s+.+)?$/g, 'ssh-[REDACTED]');

  return out;
}

/**
 * Process and log input data
 * @param {string} data - Input data from terminal
 * @param {string} [terminalId='global'] - Terminal identifier to keep buffers isolated
 */
function logInput(data, terminalId = 'global') {
  const key = terminalId || 'global';
  let inputBuffer = inputBuffers.get(key) || '';

  for (let char of data) {
    if (char === '\r' || char === '\n') {
      // Enter pressed - save the line
      if (inputBuffer.trim().length > 0) {
        const timestamp = new Date().toISOString();
        const safeLine = sanitizeHistoryLine(inputBuffer, key);
        const logEntry = `[${timestamp}] ${safeLine}\n`;
        enqueueLogWrite(logEntry);
      }
      inputBuffer = '';
    } else if (char === '\x7f' || char === '\b') {
      // Backspace - remove last char
      inputBuffer = inputBuffer.slice(0, -1);
    } else if (char >= ' ' && char <= '~') {
      // Printable character
      inputBuffer += char;
    }
  }

  inputBuffers.set(key, inputBuffer);
}

/**
 * Get prompt history
 * @returns {Promise<string>} History file contents
 */
async function getHistory() {
  if (!logFilePath) return '';

  let handle = null;
  try {
    handle = await fsp.open(logFilePath, 'r');
    const { size } = await handle.stat();

    // Read only the tail. The history file is append-only and never rotated, so
    // it grows without bound; reading it whole put the entire file in main
    // memory, over IPC, and into one DOM node per line. The panel shows newest
    // first anyway, and the full file stays on disk for "Open History File".
    const start = Math.max(0, size - MAX_HISTORY_READ_BYTES);
    const length = size - start;
    if (length <= 0) return '';

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');

    // A tail read can begin mid-line, and therefore mid-UTF-8-sequence;
    // dropping the partial first line discards both.
    if (start > 0) {
      const newlineIndex = text.indexOf('\n');
      text = newlineIndex === -1 ? '' : text.slice(newlineIndex + 1);
    }

    const lines = text.split('\n');
    if (lines.length > MAX_HISTORY_LINES) {
      text = lines.slice(-MAX_HISTORY_LINES).join('\n');
    }
    return text;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('Error reading prompt history:', err);
    }
    return '';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  ipcMain.on(IPC.LOAD_PROMPT_HISTORY, async (event) => {
    const data = await getHistory();
    if (!event.sender.isDestroyed()) event.sender.send(IPC.PROMPT_HISTORY_DATA, data);
  });
}

module.exports = {
  init,
  logInput,
  getHistory,
  getLogFilePath,
  sanitizeHistoryLine,
  setupIPC
};
