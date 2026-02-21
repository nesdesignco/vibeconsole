/**
 * Plugins Panel Module
 * UI for displaying and managing Claude Code plugins
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { shellQuote } = require('./shellEscape');
const { createPanelHeaderDropdown } = require('./panelHeaderDropdown');
const { withSpinner } = require('./spinnerButton');
const { createToast } = require('./toast');
const { createPanelVisibility } = require('./panelVisibility');
let pluginsData = [];
let currentFilter = 'all'; // all, installed, enabled

// DOM Elements
let panelElement = null;
let contentElement = null;
let filterDropdownControl = null;
let _toast = null;
let _panel = null;

/**
 * Initialize plugins panel
 */
function init() {
  panelElement = document.getElementById('plugins-panel');
  contentElement = document.getElementById('plugins-content');

  if (!panelElement) {
    console.error('Plugins panel element not found');
    return;
  }

  _toast = createToast(panelElement);
  _panel = createPanelVisibility(panelElement, { onShow: loadPlugins });

  setupEventListeners();
  setupIPCListeners();
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Close button
  const closeBtn = document.getElementById('plugins-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', hide);
  }

  // Collapse button
  const collapseBtn = document.getElementById('plugins-collapse-btn');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', hide);
  }

  // Refresh button
  const refreshBtn = document.getElementById('plugins-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshPlugins);
  }

  // Header dropdown filter
  const filterDropdown = document.getElementById('plugins-filter-dropdown');
  if (filterDropdown) {
    filterDropdownControl = createPanelHeaderDropdown(filterDropdown, {
      onChange: (filter) => setFilter(filter, { syncDropdown: false })
    });
  }

  if (contentElement) {
    contentElement.addEventListener('click', async (e) => {
      const toggleBtn = e.target.closest('.plugin-toggle-btn');
      if (toggleBtn) {
        e.stopPropagation();
        const pluginId = toggleBtn.dataset.pluginId;
        if (pluginId) await togglePlugin(pluginId);
        return;
      }

      const installBtn = e.target.closest('.plugin-install-btn');
      if (installBtn) {
        e.stopPropagation();
        const pluginName = installBtn.dataset.pluginName;
        if (pluginName) installPlugin(pluginName);
      }
    });
  }
}

/**
 * Setup IPC listeners
 */
function setupIPCListeners() {
  ipcRenderer.on(IPC.PLUGIN_TOGGLED, (event, result) => {
    if (result.success) {
      // Update local data
      const plugin = pluginsData.find(p => p.id === result.pluginId);
      if (plugin) {
        plugin.enabled = result.enabled;
        render();
      }
      showToast(
        result.enabled ? 'Plugin enabled - restart Claude Code to apply' : 'Plugin disabled - restart Claude Code to apply',
        'info'
      );
    }
  });

  ipcRenderer.on(IPC.TOGGLE_PLUGINS_PANEL, () => {
    toggle();
  });
}

/**
 * Load plugins
 */
async function loadPlugins() {
  try {
    pluginsData = await ipcRenderer.invoke(IPC.LOAD_PLUGINS);
    render();
  } catch (err) {
    console.error('Error loading plugins:', err);
    pluginsData = [];
    render();
  }
}

/**
 * Refresh plugins from marketplace
 */
async function refreshPlugins() {
  const refreshBtn = document.getElementById('plugins-refresh-btn');

  await withSpinner(refreshBtn, async () => {
    try {
      const result = await ipcRenderer.invoke(IPC.REFRESH_PLUGINS);

      if (result.error) {
        showToast('Failed to refresh plugins', 'error');
      } else {
        pluginsData = result;
        render();
        showToast('Plugins refreshed', 'success');
      }
    } catch (err) {
      console.error('Error refreshing plugins:', err);
      showToast('Failed to refresh plugins', 'error');
    }
  });
}

function show() { if (_panel) _panel.show(); }
function hide() { if (_panel) _panel.hide(); }
function toggle() { if (_panel) _panel.toggle(); }

/**
 * Set filter
 */
function setFilter(filter, options = {}) {
  const { syncDropdown = true } = options;
  currentFilter = filter;
  if (syncDropdown && filterDropdownControl) {
    filterDropdownControl.setValue(filter);
  }

  render();
}

/**
 * Get filtered plugins
 */
function getFilteredPlugins() {
  if (!pluginsData || pluginsData.length === 0) return [];

  switch (currentFilter) {
    case 'installed':
      return pluginsData.filter(p => p.installed);
    case 'enabled':
      return pluginsData.filter(p => p.enabled);
    default:
      return pluginsData;
  }
}

/**
 * Render plugins list
 */
function render() {
  if (!contentElement) return;

  const plugins = getFilteredPlugins();

  if (plugins.length === 0) {
    contentElement.innerHTML = `
      <div class="plugins-empty">
        <div class="plugins-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/><path d="M7 8h10"/>
          </svg>
        </div>
        <p>No plugins found</p>
        <span>${currentFilter === 'all' ? 'Claude Code plugins will appear here' : `No ${currentFilter} plugins`}</span>
      </div>
    `;
    return;
  }

  contentElement.innerHTML = plugins.map(plugin => renderPluginItem(plugin)).join('');
}

/**
 * Render single plugin item
 */
function renderPluginItem(plugin) {
  const statusClass = plugin.enabled ? 'enabled' : plugin.installed ? 'installed' : 'available';
  const statusLabel = plugin.enabled ? 'Enabled' : plugin.installed ? 'Installed' : '';

  // Icon based on plugin type/name
  const icon = getPluginIcon(plugin.name);

  return `
    <div class="plugin-item ${statusClass}" data-plugin-id="${escapeAttr(plugin.id)}">
      <div class="plugin-icon">
        ${icon}
      </div>
      <div class="plugin-content">
        <div class="plugin-header">
          <span class="plugin-name">${escapeHtml(plugin.name)}</span>
          ${statusLabel ? `<span class="plugin-status status-${statusClass}">${statusLabel}</span>` : ''}
        </div>
        <div class="plugin-description">${escapeHtml(plugin.description)}</div>
        <div class="plugin-meta">
          <span class="plugin-author">by ${escapeHtml(plugin.author)}</span>
        </div>
      </div>
      <div class="plugin-actions">
        ${plugin.installed ? `
          <button class="plugin-toggle-btn ${plugin.enabled ? 'enabled' : ''}"
                  data-plugin-id="${escapeAttr(plugin.id)}"
                  title="${plugin.enabled ? 'Disable' : 'Enable'}">
            <div class="toggle-track">
              <div class="toggle-thumb"></div>
            </div>
          </button>
        ` : `
          <button class="plugin-install-btn"
                  data-plugin-name="${escapeAttr(plugin.name)}"
                  title="Install plugin">
            Install
          </button>
        `}
      </div>
    </div>
  `;
}

/**
 * Get icon for plugin based on name
 */
function getPluginIcon(name) {
  // Return different icons based on plugin category
  if (name.includes('lsp') || name.includes('typescript') || name.includes('python')) {
    // Language/LSP icon
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
    </svg>`;
  }

  if (name.includes('commit') || name.includes('pr') || name.includes('review')) {
    // Git icon
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>
    </svg>`;
  }

  if (name.includes('security')) {
    // Security icon
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>`;
  }

  if (name.includes('frontend') || name.includes('design')) {
    // Design icon
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
    </svg>`;
  }

  // Default plugin icon (plug)
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/><path d="M7 8h10"/>
  </svg>`;
}

/**
 * Toggle plugin enabled/disabled
 */
async function togglePlugin(pluginId) {
  try {
    await ipcRenderer.invoke(IPC.TOGGLE_PLUGIN, pluginId);
  } catch (err) {
    console.error('Error toggling plugin:', err);
    showToast('Failed to toggle plugin', 'error');
  }
}

/**
 * Install plugin via terminal command
 */
function installPlugin(pluginName) {
  const command = `claude plugin install ${shellQuote(pluginName)}`;

  // Send command to terminal
  if (typeof window.terminalSendCommand === 'function') {
    window.terminalSendCommand(command);
    showToast(`Installing ${pluginName}...`, 'info');
    // Hide panel so user can see terminal
    hide();
  } else {
    showToast('Terminal not available', 'error');
  }
}

/**
 * Show toast notification (delegates to shared toast utility)
 */
function showToast(message, type = 'info') {
  if (_toast) _toast.show(message, type);
}

const { escapeHtml, escapeAttr } = require('./escapeHtml');

module.exports = {
  init,
  show,
  hide,
  toggle,
  loadPlugins,
  isVisible: () => _panel ? _panel.isVisible() : false
};
