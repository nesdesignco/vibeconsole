/**
 * Codex Usage Manager Module
 * Reads Codex CLI session JSONL files for usage data and provides periodic updates
 * Session files are at: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Token count events contain rate_limits.primary (5-hour) and rate_limits.secondary (weekly)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { IPC } = require('../shared/ipcChannels');

let mainWindow = null;
let cachedUsage = null;
let watcher = null;
let pollingInterval = null;
let lastSessionFile = null;
let initialFetchTimeout = null;
const MAX_JSONL_TAIL_BYTES = 1024 * 1024; // 1MB

function toNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoFromUnixSeconds(seconds) {
  const value = toNumberOrNull(seconds);
  if (value === null) return null;
  const millis = value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseTokenCountCandidatesFromContent(content) {
  const lines = String(content || '').split('\n');
  const candidates = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const event = JSON.parse(line);
      if (event.type !== 'event_msg' || event.payload?.type !== 'token_count' || !event.payload?.rate_limits) {
        continue;
      }

      const rateLimits = event.payload.rate_limits;
      const primaryUsage = toNumberOrNull(rateLimits.primary?.used_percent);
      const secondaryUsage = toNumberOrNull(rateLimits.secondary?.used_percent);

      candidates.push({
        tokenCount: event.payload,
        limitId: typeof rateLimits.limit_id === 'string' ? rateLimits.limit_id : null,
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
        hasUsageValues: primaryUsage !== null || secondaryUsage !== null
      });
    } catch {
      // Skip malformed lines
    }
  }

  return candidates;
}

function isModelSpecificCodexLimit(limitId) {
  return typeof limitId === 'string' && /^codex_/i.test(limitId);
}

function selectBestRateLimit(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const withUsage = candidates.filter(candidate => candidate.hasUsageValues);
  const pool = withUsage.length > 0 ? withUsage : candidates;

  const aggregate = pool.find(candidate => candidate.limitId === 'codex');
  if (aggregate) return aggregate;

  const modelSpecific = pool.find(candidate => isModelSpecificCodexLimit(candidate.limitId));
  if (modelSpecific) return modelSpecific;

  return pool[0] || null;
}

/**
 * Initialize the module with window reference
 */
function init(window) {
  mainWindow = window;
  startPolling();
}

/**
 * Get the Codex sessions base directory
 */
function getSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/**
 * Find recent rollout JSONL files ordered newest first.
 * Searches ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
async function findRecentSessionFiles(limit = 50) {
  const sessionsDir = getSessionsDir();
  const results = [];

  try {
    await fsp.access(sessionsDir);

    // Get year directories, sorted descending
    const years = (await fsp.readdir(sessionsDir, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(d => /^\d{4}$/.test(d))
      .sort((a, b) => b.localeCompare(a));

    for (const year of years) {
      const yearDir = path.join(sessionsDir, year);
      const months = (await fsp.readdir(yearDir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(d => /^\d{2}$/.test(d))
        .sort((a, b) => b.localeCompare(a));

      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const days = (await fsp.readdir(monthDir, { withFileTypes: true }))
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .filter(d => /^\d{2}$/.test(d))
          .sort((a, b) => b.localeCompare(a));

        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          const files = (await fsp.readdir(dayDir, { withFileTypes: true }))
            .filter(d => d.isFile())
            .map(d => d.name)
            .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
            .sort((a, b) => b.localeCompare(a));

          for (const file of files) {
            results.push(path.join(dayDir, file));
            if (results.length >= limit) {
              return results;
            }
          }
        }
      }
    }
  } catch {
  }

  return results;
}

/**
 * Parse token_count events from a JSONL file
 * Returns best matching token_count candidate
 */
async function parseBestTokenCount(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    let content = '';

    if (stats.size <= MAX_JSONL_TAIL_BYTES) {
      content = await fsp.readFile(filePath, 'utf8');
    } else {
      // Large file: parse from tail to avoid repeatedly loading full JSONL.
      const start = stats.size - MAX_JSONL_TAIL_BYTES;
      const handle = await fsp.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(MAX_JSONL_TAIL_BYTES);
        await handle.read(buffer, 0, MAX_JSONL_TAIL_BYTES, start);
        content = buffer.toString('utf8');
      } finally {
        await handle.close();
      }

      // Drop potentially truncated first line from tail chunk.
      const firstNewline = content.indexOf('\n');
      content = firstNewline === -1 ? '' : content.slice(firstNewline + 1);
    }

    const candidates = parseTokenCountCandidatesFromContent(content);
    return selectBestRateLimit(candidates);
  } catch {
    return null;
  }
}

/**
 * Normalize Codex token_count data to the same format as Claude usage
 */
function normalizeUsage(selectedCandidate) {
  const tokenCount = selectedCandidate?.tokenCount || null;
  if (!tokenCount || !tokenCount.rate_limits) {
    return {
      fiveHour: null,
      sevenDay: null,
      sourceLimitId: null,
      sourceTimestamp: null,
      lastUpdated: new Date().toISOString(),
      error: 'No usage data available'
    };
  }

  const primary = tokenCount.rate_limits.primary;
  const secondary = tokenCount.rate_limits.secondary;

  return {
    fiveHour: primary ? {
      utilization: primary.used_percent || 0,
      resetsAt: toIsoFromUnixSeconds(primary.resets_at)
    } : null,
    sevenDay: secondary ? {
      utilization: secondary.used_percent || 0,
      resetsAt: toIsoFromUnixSeconds(secondary.resets_at)
    } : null,
    sourceLimitId: selectedCandidate?.limitId || null,
    sourceTimestamp: selectedCandidate?.timestamp || null,
    lastUpdated: new Date().toISOString(),
    error: null
  };
}

/**
 * Fetch usage data from Codex session files
 */
async function fetchUsage() {
  const sessionFiles = await findRecentSessionFiles();
  const sessionFile = sessionFiles[0] || null;

  if (!sessionFile) {
    return {
      fiveHour: null,
      sevenDay: null,
      lastUpdated: new Date().toISOString(),
      error: 'No Codex session files found'
    };
  }

  // Setup watcher on this file if it changed
  if (sessionFile !== lastSessionFile) {
    setupWatcher(sessionFile);
    lastSessionFile = sessionFile;
  }

  let selected = await parseBestTokenCount(sessionFile);

  // New session files often start with metadata only. Reuse cache first, and
  // only scan older files when no cache is available yet.
  if (!selected && cachedUsage && !cachedUsage.error) {
    return cachedUsage;
  }

  if (!selected) {
    for (let i = 1; i < sessionFiles.length; i++) {
      selected = await parseBestTokenCount(sessionFiles[i]);
      if (selected) break;
    }
  }

  const usage = normalizeUsage(selected);
  if (usage.error && cachedUsage && !cachedUsage.error) {
    return cachedUsage;
  }
  cachedUsage = usage;
  return usage;
}

/**
 * Setup file watcher on the active session file
 */
function setupWatcher(filePath) {
  // Clean up previous watcher
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  try {
    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);

    watcher = fs.watch(dir, (_eventType, changedFile) => {
      const changedName = changedFile ? changedFile.toString() : '';
      if (changedName === filename) {
        // File changed, send updated usage to renderer
        sendUsageToRenderer();
      }
    });

    watcher.on('error', () => {
      // Watcher failed, rely on polling
      watcher = null;
    });
  } catch {
  }
}

/**
 * Send usage data to renderer
 */
async function sendUsageToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const usage = await fetchUsage();
  mainWindow.webContents.send(IPC.AI_USAGE_DATA, { toolId: 'codex', ...usage });
}

/**
 * Start periodic polling for usage updates
 */
function startPolling(interval = 30000) {
  stopPolling();

  // Initial fetch after a short delay
  initialFetchTimeout = setTimeout(() => {
    sendUsageToRenderer();
  }, 3000);

  // Periodic updates as fallback
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
 */
function setupIPC(ipcMain) {
  // Handled via generic AI_USAGE routing in main/index.js
  // No direct IPC handlers needed here
}

/**
 * Get cached usage if available
 * @returns {Object|null} Cached usage data or null
 */
function getCachedUsage() {
  return cachedUsage || null;
}

/**
 * Cleanup on app quit
 */
function cleanup() {
  stopPolling();
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  mainWindow = null;
}

module.exports = {
  init,
  setupIPC,
  cleanup,
  fetchUsage,
  getCachedUsage,
  parseTokenCountCandidatesFromContent,
  selectBestRateLimit,
  normalizeUsage,
  toIsoFromUnixSeconds
};
