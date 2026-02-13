/**
 * Claude Usage Manager Module
 * Fetches Claude Code usage data from OAuth API and provides periodic updates
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const { IPC } = require('../shared/ipcChannels');
const execFileAsync = promisify(execFile);

let mainWindow = null;
let pollingInterval = null;
let initialFetchTimeout = null;
let cachedUsage = null;
let lastFetchTime = null;

/**
 * Initialize the module with window reference
 */
function init(window) {
  mainWindow = window;
  // Start polling when window is ready
  startPolling();
}

/**
 * Get OAuth token from macOS Keychain
 * @returns {Promise<string|null>} Access token or null if not found
 */
async function getOAuthToken() {
  try {
    // macOS Keychain command (execFile prevents shell injection)
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 5000 }
    );
    const result = stdout.trim();

    if (!result) return null;

    // Parse JSON to get the access token
    const credentials = JSON.parse(result);

    // Token can be in different locations depending on auth method
    if (credentials.claudeAiOauth?.accessToken) {
      return credentials.claudeAiOauth.accessToken;
    }
    if (credentials.accessToken) {
      return credentials.accessToken;
    }

    return null;
  } catch {
    // Token not found or parse error
    return null;
  }
}

/**
 * Fetch usage data from Claude OAuth API
 * @returns {Promise<Object>} Usage data or error
 */
async function fetchUsage() {
  const token = await getOAuthToken();

  if (!token) {
    return {
      error: 'No OAuth token found',
      fiveHour: null,
      sevenDay: null,
      lastUpdated: new Date().toISOString()
    };
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const usage = JSON.parse(data);
            const result = {
              fiveHour: {
                utilization: usage.five_hour?.utilization || 0,
                resetsAt: usage.five_hour?.resets_at || null
              },
              sevenDay: {
                utilization: usage.seven_day?.utilization || 0,
                resetsAt: usage.seven_day?.resets_at || null
              },
              lastUpdated: new Date().toISOString(),
              error: null
            };
            cachedUsage = result;
            lastFetchTime = Date.now();
            resolve(result);
          } else if (res.statusCode === 401) {
            resolve({
              error: 'Token expired or invalid',
              fiveHour: null,
              sevenDay: null,
              lastUpdated: new Date().toISOString()
            });
          } else {
            resolve({
              error: `API error: ${res.statusCode}`,
              fiveHour: null,
              sevenDay: null,
              lastUpdated: new Date().toISOString()
            });
          }
        } catch {
          resolve({
            error: 'Failed to parse response',
            fiveHour: null,
            sevenDay: null,
            lastUpdated: new Date().toISOString()
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        error: `Network error: ${err.message}`,
        fiveHour: cachedUsage?.fiveHour || null,
        sevenDay: cachedUsage?.sevenDay || null,
        lastUpdated: cachedUsage?.lastUpdated || new Date().toISOString()
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        error: 'Request timeout',
        fiveHour: cachedUsage?.fiveHour || null,
        sevenDay: cachedUsage?.sevenDay || null,
        lastUpdated: cachedUsage?.lastUpdated || new Date().toISOString()
      });
    });

    req.end();
  });
}

/**
 * Send usage data to renderer
 */
async function sendUsageToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const usage = await fetchUsage();
  if (!usage.error) {
    // Good data - push it
    mainWindow.webContents.send(IPC.AI_USAGE_DATA, { toolId: 'claude', ...usage });
  } else if (cachedUsage && !cachedUsage.error) {
    // Error but we have valid cached data - push cached instead
    mainWindow.webContents.send(IPC.AI_USAGE_DATA, { toolId: 'claude', ...cachedUsage });
  }
  // If error and no valid cache, don't push anything - avoid wiping renderer state
}

/**
 * Start periodic polling for usage updates
 * @param {number} interval - Polling interval in ms (default: 60000 = 1 minute)
 */
function startPolling(interval = 60000) {
  // Stop any existing polling
  stopPolling();

  // Initial fetch after a short delay
  initialFetchTimeout = setTimeout(() => {
    sendUsageToRenderer();
  }, 2000);

  // Start periodic updates
  pollingInterval = setInterval(() => {
    sendUsageToRenderer();
  }, interval);
}

/**
 * Stop polling
 */
function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (initialFetchTimeout) {
    clearTimeout(initialFetchTimeout);
    initialFetchTimeout = null;
  }
}

/**
 * Setup IPC handlers
 * @param {Electron.IpcMain} _ipcMain
 */
function setupIPC(_ipcMain) {
  // Legacy handlers removed - usage routing handled via LOAD_AI_USAGE/REFRESH_AI_USAGE in index.js
}

/**
 * Get cached usage if fresh (< 60s old)
 * @returns {Object|null} Cached usage data or null
 */
function getCachedUsage() {
  if (cachedUsage && lastFetchTime && (Date.now() - lastFetchTime) < 60000) {
    return cachedUsage;
  }
  return null;
}

/**
 * Cleanup on app quit
 */
function cleanup() {
  stopPolling();
  mainWindow = null;
}

module.exports = {
  init,
  setupIPC,
  cleanup,
  fetchUsage,
  getCachedUsage,
  startPolling,
  stopPolling
};
