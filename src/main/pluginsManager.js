/**
 * Plugins Manager Module
 * Handles Claude Code plugins - reading marketplace, installed, and enabled status
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { IPC } = require('../shared/ipcChannels');
const { isPathWithinDirectory } = require('../shared/pathValidation');
const execFileAsync = promisify(execFile);

let mainWindow = null;
const OFFICIAL_MARKETPLACE_REPO = 'https://github.com/anthropics/claude-plugins-official.git';
const TRUSTED_MARKETPLACE_REMOTES = new Set([
  'https://github.com/anthropics/claude-plugins-official',
  OFFICIAL_MARKETPLACE_REPO.replace(/\.git$/, ''),
  OFFICIAL_MARKETPLACE_REPO,
  'git@github.com:anthropics/claude-plugins-official',
  'git@github.com:anthropics/claude-plugins-official.git',
  'ssh://git@github.com/anthropics/claude-plugins-official',
  'ssh://git@github.com/anthropics/claude-plugins-official.git'
]);
const PLUGIN_ID_RE = /^[A-Za-z0-9._-]+@claude-plugins-official$/;

// Claude Code paths
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const INSTALLED_PLUGINS_FILE = path.join(PLUGINS_DIR, 'installed_plugins.json');
const MARKETPLACES_DIR = path.join(PLUGINS_DIR, 'marketplaces');

/**
 * Initialize plugins manager
 */
function init(window) {
  mainWindow = window;
}

/**
 * Read JSON file safely
 */
function readJsonFile(filePath, allowedBase = CLAUDE_DIR) {
  try {
    if (!isPathWithinDirectory(filePath, allowedBase)) {
      console.error(`Blocked JSON read outside managed path: ${filePath}`);
      return null;
    }
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
  }
  return null;
}

/**
 * Write JSON file safely
 */
function writeJsonFile(filePath, data, allowedBase = CLAUDE_DIR) {
  try {
    if (!isPathWithinDirectory(filePath, allowedBase)) {
      console.error(`Blocked JSON write outside managed path: ${filePath}`);
      return false;
    }

    const dir = path.dirname(filePath);
    if (!isPathWithinDirectory(dir, allowedBase)) {
      console.error(`Blocked JSON write to unmanaged directory: ${dir}`);
      return false;
    }

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const tempPath = path.join(dir, `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
    return false;
  }
}

/**
 * Get enabled plugins from settings
 */
function getEnabledPlugins() {
  const settings = readJsonFile(SETTINGS_FILE, CLAUDE_DIR);
  return settings?.enabledPlugins || {};
}

/**
 * Get installed plugins
 */
function getInstalledPlugins() {
  const data = readJsonFile(INSTALLED_PLUGINS_FILE, PLUGINS_DIR);
  return data?.plugins || {};
}

function normalizeRemote(remote) {
  return String(remote || '').trim().replace(/\.git$/, '');
}

function isTrustedMarketplaceRemote(remote) {
  return TRUSTED_MARKETPLACE_REMOTES.has(String(remote || '').trim())
    || TRUSTED_MARKETPLACE_REMOTES.has(normalizeRemote(remote));
}

async function getMarketplaceOriginUrl(repoPath) {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      timeout: 15000,
      encoding: 'utf8'
    });
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

async function hasTrustedMarketplaceOrigin(repoPath) {
  if (!fs.existsSync(repoPath) || !isPathWithinDirectory(repoPath, MARKETPLACES_DIR)) {
    return false;
  }

  const remote = await getMarketplaceOriginUrl(repoPath);
  return isTrustedMarketplaceRemote(remote);
}

function isValidPluginId(pluginId) {
  return typeof pluginId === 'string' && PLUGIN_ID_RE.test(pluginId);
}

/**
 * Get all available plugins from marketplace
 */
async function getMarketplacePlugins() {
  const plugins = [];
  const officialMarketplace = path.join(MARKETPLACES_DIR, 'claude-plugins-official', 'plugins');

  if (!fs.existsSync(officialMarketplace)) {
    // Try to initialize it
    const initialized = await ensureOfficialMarketplace();
    
    // Check again
    if (!initialized || !fs.existsSync(officialMarketplace)) {
      return plugins;
    }
  }

  if (!(await hasTrustedMarketplaceOrigin(path.dirname(officialMarketplace)))) {
    console.error('Blocked plugin marketplace read: repository origin is untrusted');
    return plugins;
  }

  try {
    const pluginDirs = fs.readdirSync(officialMarketplace, { withFileTypes: true });

    for (const entry of pluginDirs) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const pluginName = entry.name;
      const pluginPath = path.join(officialMarketplace, pluginName);
      const configPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');

      if (fs.existsSync(configPath)) {
        const config = readJsonFile(configPath, officialMarketplace);
        if (config) {
          plugins.push({
            id: `${pluginName}@claude-plugins-official`,
            name: config.name || pluginName,
            description: config.description || '',
            author: config.author?.name || 'Unknown',
            path: pluginPath
          });
        }
      }
    }
  } catch (err) {
    console.error('Error reading marketplace plugins:', err);
  }

  return plugins;
}

/**
 * Get all plugins with their status
 */
async function getAllPlugins() {
  const marketplacePlugins = await getMarketplacePlugins();
  const installedPlugins = getInstalledPlugins();
  const enabledPlugins = getEnabledPlugins();

  return marketplacePlugins.map(plugin => {
    const isInstalled = !!installedPlugins[plugin.id];
    const isEnabled = enabledPlugins[plugin.id] === true;
    const installInfo = installedPlugins[plugin.id]?.[0];

    return {
      ...plugin,
      installed: isInstalled,
      enabled: isEnabled,
      installedAt: installInfo?.installedAt || null
    };
  });
}

/**
 * Toggle plugin enabled/disabled status
 */
function togglePlugin(pluginId) {
  if (!isValidPluginId(pluginId)) {
    return { success: false, pluginId, enabled: false, error: 'Invalid plugin ID' };
  }

  const installedPlugins = getInstalledPlugins();
  if (!installedPlugins[pluginId]) {
    return { success: false, pluginId, enabled: false, error: 'Plugin is not installed' };
  }

  const settings = readJsonFile(SETTINGS_FILE) || {};

  if (!settings.enabledPlugins) {
    settings.enabledPlugins = {};
  }

  // Toggle the status
  const currentStatus = settings.enabledPlugins[pluginId] === true;
  settings.enabledPlugins[pluginId] = !currentStatus;

  const success = writeJsonFile(SETTINGS_FILE, settings, CLAUDE_DIR);

  return {
    success,
    pluginId,
    enabled: !currentStatus
  };
}

/**
 * Ensure official marketplace exists
 */
async function ensureOfficialMarketplace() {
  const officialMarketplace = path.join(MARKETPLACES_DIR, 'claude-plugins-official');
  
  if (fs.existsSync(officialMarketplace)) {
    return hasTrustedMarketplaceOrigin(officialMarketplace);
  }

  try {
    // Create marketplaces dir if it doesn't exist
    if (!fs.existsSync(MARKETPLACES_DIR)) {
      fs.mkdirSync(MARKETPLACES_DIR, { recursive: true });
    }

    await execFileAsync('git', ['clone', '--depth', '1', OFFICIAL_MARKETPLACE_REPO], {
      cwd: MARKETPLACES_DIR,
      timeout: 60000,
      encoding: 'utf8'
    });
    return hasTrustedMarketplaceOrigin(officialMarketplace);
  } catch (err) {
    console.error('Error cloning official marketplace:', err);
    return false;
  }
}

/**
 * Refresh marketplace plugins (git pull or clone)
 */
async function refreshMarketplace() {
  const officialMarketplace = path.join(MARKETPLACES_DIR, 'claude-plugins-official');

  // If not exists, try to clone
  if (!fs.existsSync(officialMarketplace)) {
    const success = await ensureOfficialMarketplace();
    if (!success) {
      return { success: false, error: 'Failed to clone trusted marketplace' };
    }
    return { success: true };
  }

  if (!(await hasTrustedMarketplaceOrigin(officialMarketplace))) {
    return { success: false, error: 'Marketplace repository origin is untrusted' };
  }

  try {
    await execFileAsync('git', ['pull'], {
      cwd: officialMarketplace,
      timeout: 30000,
      encoding: 'utf8'
    });
    return { success: true };
  } catch (err) {
    console.error('Error refreshing marketplace:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  // Load all plugins
  ipcMain.handle(IPC.LOAD_PLUGINS, async () => {
    return await getAllPlugins();
  });

  // Toggle plugin
  ipcMain.handle(IPC.TOGGLE_PLUGIN, async (event, pluginId) => {
    const result = togglePlugin(pluginId);

    // Notify renderer of the change
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.PLUGIN_TOGGLED, result);
    }

    return result;
  });

  // Refresh plugins marketplace
  ipcMain.handle(IPC.REFRESH_PLUGINS, async () => {
    const result = await refreshMarketplace();
    if (result.success) {
      return await getAllPlugins();
    }
    return { error: result.error };
  });
}

module.exports = {
  init,
  setupIPC,
  getAllPlugins,
  togglePlugin,
  isValidPluginId,
  isTrustedMarketplaceRemote
};
