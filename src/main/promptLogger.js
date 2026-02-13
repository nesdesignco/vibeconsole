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
  try {
    if (logFilePath) {
      await fsp.access(logFilePath);
      return await fsp.readFile(logFilePath, 'utf8');
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('Error reading prompt history:', err);
    }
  }
  return '';
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
