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
  writeQueue = writeQueue
    .then(() => fsp.appendFile(logFilePath, logEntry, 'utf8'))
    .catch((err) => {
      console.error('Error writing prompt history:', err);
    });
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
        const logEntry = `[${timestamp}] ${inputBuffer}\n`;
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
  setupIPC
};
