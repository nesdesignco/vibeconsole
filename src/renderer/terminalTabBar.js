/**
 * Terminal Tab Bar Module
 * Renders and manages the terminal tab bar UI
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { escapeHtml, escapeAttr } = require('./escapeHtml');
const pluginsPanel = require('./pluginsPanel');
const githubPanel = require('./githubPanel');
const savedPromptsPanel = require('./savedPromptsPanel');
const { AI_TOOL_ICONS } = require('./aiToolSelector');

const AI_TOOL_FULL_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex CLI'
};

class TerminalTabBar {
  constructor(container, manager) {
    this.container = container;
    this.manager = manager;
    this.element = null;
    this.contextMenu = null;
    this.shellMenu = null;
    this.availableShells = [];
    this._abortController = new AbortController();
    this._gitChangesPollInterval = null;
    this._currentUsageTool = null; // Track which tool's usage is displayed
    this._usageRetryCount = 0; // Retry counter for failed usage loads
    this._usageRetryTimer = null; // Timer for retry scheduling
    this._ipcCleanup = [];
    this._stateCleanup = [];
    this._injectStyles();
    this._render();
    this._createContextMenu();
    this._createShellMenu();
    this._loadAvailableShells();
  }

  destroy() {
    this._abortController.abort();
    if (this._gitChangesPollInterval) {
      clearInterval(this._gitChangesPollInterval);
      this._gitChangesPollInterval = null;
    }
    if (this._usageRetryTimer) {
      clearTimeout(this._usageRetryTimer);
      this._usageRetryTimer = null;
    }
    this._ipcCleanup.forEach((cleanup) => cleanup());
    this._ipcCleanup = [];
    this._stateCleanup.forEach((cleanup) => cleanup());
    this._stateCleanup = [];
    this.contextMenu?.remove();
    this.contextMenu = null;
    this.shellMenu?.remove();
    this.shellMenu = null;
    this.element?.remove();
    this.element = null;
  }

  _addIpcListener(channel, listener) {
    ipcRenderer.on(channel, listener);
    this._ipcCleanup.push(() => ipcRenderer.removeListener(channel, listener));
  }

  _injectStyles() {
    const styleId = 'terminal-tab-context-menu-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .terminal-context-menu {
          position: fixed;
          background: var(--bg-elevated);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-md);
          padding: 4px;
          z-index: 1000;
          display: none;
          min-width: 120px;
          animation: fadeIn 0.1s ease-out;
        }
        .terminal-context-menu.visible {
          display: block;
        }
        .terminal-context-menu-item {
          padding: 6px 12px;
          font-size: 12px;
          color: var(--text-primary);
          cursor: pointer;
          border-radius: var(--radius-sm);
          display: flex;
          align-items: center;
          gap: 8px;
          transition: background var(--transition-fast);
        }
        .terminal-context-menu-item:hover {
          background: var(--bg-hover);
        }
        .terminal-context-menu-item svg {
          opacity: 0.7;
        }
        .terminal-context-menu-item.default {
          font-weight: 500;
        }
        .terminal-context-menu-item .shell-default-badge {
          font-size: 10px;
          color: var(--text-secondary);
          margin-left: auto;
        }
        .terminal-context-menu-divider {
          height: 1px;
          background: var(--border-subtle);
          margin: 4px 0;
        }
        .shell-menu {
          min-width: 160px;
        }
        .shell-menu-header {
          padding: 6px 12px;
          font-size: 11px;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      `;
      document.head.appendChild(style);
    }
  }

  _createContextMenu() {
    this.contextMenu = document.createElement('div');
    this.contextMenu.className = 'terminal-context-menu';
    document.body.appendChild(this.contextMenu);
    
    // Hide menu on click elsewhere
    document.addEventListener('click', () => {
      this._hideContextMenu();
    }, { signal: this._abortController.signal });

    // Hide menu on scroll
    document.addEventListener('scroll', () => {
      this._hideContextMenu();
    }, { capture: true, signal: this._abortController.signal });
  }

  _render() {
    this.element = document.createElement('div');
    this.element.className = 'terminal-toolbar-wrapper';
    this.element.innerHTML = `
      <div class="terminal-toolbar">
        <div class="toolbar-left">
          <div class="ai-usage-bars" title="Click to refresh">
            <div class="usage-tool">
              <span class="usage-tool-icon" aria-hidden="true"></span>
              <span class="usage-tool-name">AI Tool</span>
            </div>
            <div class="usage-metrics">
              <div class="usage-item session">
                <span class="usage-label">Session</span>
                <div class="usage-bar-container">
                  <div class="usage-bar-fill"></div>
                </div>
                <span class="usage-percent">--</span>
                <span class="usage-reset"></span>
              </div>
              <div class="usage-item weekly">
                <span class="usage-label">Weekly</span>
                <div class="usage-bar-container">
                  <div class="usage-bar-fill"></div>
                </div>
                <span class="usage-percent">--</span>
                <span class="usage-reset"></span>
              </div>
            </div>
          </div>
        </div>
        <div class="toolbar-right">
          <button class="toolbar-btn btn-view-toggle" title="Toggle Grid View">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 12h18M12 3v18"/>
            </svg>
          </button>
          <div class="grid-layout-dropdown" title="Grid Layout">
            <div class="grid-layout-dropdown-label">
              <span>2×2</span>
              <svg class="grid-layout-dropdown-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
            <div class="grid-layout-dropdown-menu">
              <div class="grid-layout-dropdown-item" data-value="1x2">1×2</div>
              <div class="grid-layout-dropdown-item" data-value="1x3">1×3</div>
              <div class="grid-layout-dropdown-item" data-value="1x4">1×4</div>
              <div class="grid-layout-dropdown-item" data-value="2x1">2×1</div>
              <div class="grid-layout-dropdown-item active" data-value="2x2">2×2</div>
              <div class="grid-layout-dropdown-item" data-value="3x1">3×1</div>
              <div class="grid-layout-dropdown-item" data-value="3x2">3×2</div>
              <div class="grid-layout-dropdown-item" data-value="3x3">3×3</div>
            </div>
          </div>
          <button class="toolbar-btn btn-plugins-toggle" title="Plugins (Ctrl+Shift+P)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.315 8.685a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.501 2.501 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.979.979 0 0 1 .276-.837l1.61-1.61a2.404 2.404 0 0 1 1.705-.707c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>
            </svg>
          </button>
          <button class="toolbar-btn btn-github-toggle" title="GitHub">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
            </svg>
            <span class="git-changes-badge" style="display: none;"></span>
          </button>
          <button class="toolbar-btn btn-saved-prompts-toggle" title="Saved Prompts (Ctrl+Shift+S)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="toolbar-btn btn-upgrade" title="Update available" style="display: none;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7"/>
            </svg>
            <span class="upgrade-badge"></span>
          </button>
        </div>
      </div>
      <div class="terminal-tab-bar">
        <div class="terminal-tabs"></div>
        <button class="btn-new-terminal" title="New Terminal - Click to select shell, Right-click for default">+</button>
      </div>
    `;

    this.container.appendChild(this.element);
    this._setupEventHandlers();
  }

  /**
   * Update tab bar based on state
   */
  update(state) {
    const tabsContainer = this.element.querySelector('.terminal-tabs');

    // Render tabs
    // Render tabs - Smart update to preserve DOM elements and events
    const existingTabs = Array.from(tabsContainer.children);
    const terminalIds = state.terminals.map(t => t.id);
    const existingIds = existingTabs.map(el => el.dataset.terminalId);

    // Check if we can do an in-place update (same terminals, same order)
    const canUpdateInPlace = terminalIds.length === existingIds.length &&
      terminalIds.every((id, i) => id === existingIds[i]);

    if (canUpdateInPlace) {
      // Update existing elements
      state.terminals.forEach((t, i) => {
        const tabEl = existingTabs[i];

        // Update active class
        if (t.isActive) tabEl.classList.add('active');
        else tabEl.classList.remove('active');

        // Update name if changed (and not currently being renamed)
        const nameSpan = tabEl.querySelector('.tab-name');
        if (nameSpan) {
          const newName = t.customName || t.name;
          if (nameSpan.textContent !== newName) {
            nameSpan.textContent = newName;
          }
        }
      });
    } else {
      // Full re-render
      tabsContainer.innerHTML = state.terminals.map(t => `
        <div class="terminal-tab ${t.isActive ? 'active' : ''}" data-terminal-id="${escapeAttr(t.id)}">
          <span class="tab-name">${escapeHtml(t.customName || t.name)}</span>
          <button class="btn btn-close tab-close" data-embedded data-terminal-id="${escapeAttr(t.id)}" title="Close" aria-label="Close terminal">✕</button>
        </div>
      `).join('');
    }

    // Update view toggle button
    const toggleBtn = this.element.querySelector('.btn-view-toggle');
    toggleBtn.innerHTML = state.viewMode === 'tabs'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
    toggleBtn.title = state.viewMode === 'tabs' ? 'Switch to Grid View' : 'Switch to Tab View';

    // Show/hide grid layout dropdown
    const gridDropdown = this.element.querySelector('.grid-layout-dropdown');
    gridDropdown.style.display = state.viewMode === 'grid' ? 'block' : 'none';
    if (state.viewMode !== 'grid') {
      gridDropdown.classList.remove('open');
    }

    // Update dropdown label
    const label = gridDropdown.querySelector('.grid-layout-dropdown-label span');
    label.textContent = state.gridLayout.replace('x', '×');

    // Update active item
    gridDropdown.querySelectorAll('.grid-layout-dropdown-item').forEach(item => {
      const isActive = item.dataset.value === state.gridLayout;
      item.classList.toggle('active', isActive);
      item.textContent = item.dataset.value.replace('x', '×');
    });

    // Disable new terminal button if at max
    const newBtn = this.element.querySelector('.btn-new-terminal');
    newBtn.disabled = state.terminals.length >= this.manager.maxTerminals;
    newBtn.title = newBtn.disabled ? 'Maximum terminals reached' : 'New Terminal (Ctrl+Shift+T)';

    // Update usage bars based on active terminal's aiTool
    this._updateUsageVisibility(state);
  }

  /**
   * Update usage bar visibility based on active terminal's aiTool
   */
  _updateUsageVisibility(state) {
    const usageBars = this.element.querySelector('.ai-usage-bars');
    if (!usageBars) return;

    // Find active terminal's aiTool
    const activeTerminal = state.terminals.find(t => t.id === state.activeTerminalId);
    const aiTool = activeTerminal ? activeTerminal.aiTool : null;

    if (!aiTool) {
      // Plain shell - hide usage bars
      usageBars.style.display = 'none';
      this._currentUsageTool = null;
      this._setUsageToolIndicator(null);
      return;
    }

    // Show usage bars
    usageBars.style.display = '';
    this._setUsageToolIndicator(aiTool);
    usageBars.title = this._getUsageRefreshTitle();

    // If tool changed, request new data
    if (aiTool !== this._currentUsageTool) {
      this._currentUsageTool = aiTool;
      this._usageRetryCount = 0;
      // Show loading state ("--") instead of 0%
      const container = this.element.querySelector('.ai-usage-bars');
      if (container) {
        container.querySelectorAll('.usage-percent').forEach(el => el.textContent = '--');
        container.querySelectorAll('.usage-bar-fill').forEach(el => el.style.width = '0%');
        container.querySelectorAll('.usage-reset').forEach(el => el.textContent = '');
      }
      // Request fresh data for this tool
      ipcRenderer.send(IPC.LOAD_AI_USAGE, aiTool);
    }
  }

  _setupEventHandlers() {
    const toggleExclusivePanel = (targetPanel, otherPanels) => {
      if (targetPanel.isVisible()) {
        targetPanel.hide();
        return;
      }
      otherPanels.forEach((panel) => panel.hide());
      targetPanel.show();
    };

    // Tab click - activate terminal
    this.element.addEventListener('click', (e) => {
      const tab = e.target.closest('.terminal-tab');
      if (tab && !e.target.classList.contains('tab-close')) {
        const terminalId = tab.dataset.terminalId;
        this.manager.setActiveTerminal(terminalId);
      }
    });

    // Close button click
    this.element.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        e.stopPropagation();
        const terminalId = e.target.dataset.terminalId;
        if (!confirm('Close this terminal?')) return;
        this.manager.closeTerminal(terminalId);
      }
    });

    // Double-click to rename
    this.element.addEventListener('dblclick', (e) => {
      const tab = e.target.closest('.terminal-tab');
      if (tab) {
        this._startRename(tab);
      }
    });

    // Right-click context menu
    this.element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const tab = e.target.closest('.terminal-tab');
      if (tab) {
        this._showContextMenu(e.clientX, e.clientY, tab);
      }
    });

    // New terminal button - click to show shell selection, or right-click for default shell
    const newTerminalBtn = this.element.querySelector('.btn-new-terminal');
    newTerminalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = newTerminalBtn.getBoundingClientRect();
      this._showShellMenu(rect.left, rect.bottom + 4);
    });

    // Right-click on + button to create terminal with default shell quickly
    newTerminalBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._createTerminalAndFocus();
    });

    // View toggle button
    this.element.querySelector('.btn-view-toggle').addEventListener('click', () => {
      const newMode = this.manager.viewMode === 'tabs' ? 'grid' : 'tabs';
      this.manager.setViewMode(newMode);
    });

    // Grid layout dropdown
    const gridDropdown = this.element.querySelector('.grid-layout-dropdown');
    gridDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.grid-layout-dropdown-item');
      if (item) {
        this.manager.setGridLayout(item.dataset.value);
        gridDropdown.classList.remove('open');
      } else {
        gridDropdown.classList.toggle('open');
      }
    });

    // Close grid dropdown on outside click
    document.addEventListener('click', () => {
      gridDropdown.classList.remove('open');
    }, { signal: this._abortController.signal });

    // Plugins toggle button
    this.element.querySelector('.btn-plugins-toggle').addEventListener('click', () => {
      toggleExclusivePanel(pluginsPanel, [githubPanel, savedPromptsPanel]);
    });

    // GitHub toggle button
    this.element.querySelector('.btn-github-toggle').addEventListener('click', () => {
      toggleExclusivePanel(githubPanel, [pluginsPanel, savedPromptsPanel]);
    });

    // Usage bars click to refresh
    this.element.querySelector('.ai-usage-bars').addEventListener('click', () => {
      if (this._currentUsageTool) {
        ipcRenderer.send(IPC.REFRESH_AI_USAGE, this._currentUsageTool);
      }
    });

    // Saved Prompts toggle button
    this.element.querySelector('.btn-saved-prompts-toggle').addEventListener('click', () => {
      toggleExclusivePanel(savedPromptsPanel, [pluginsPanel, githubPanel]);
    });

    // Setup usage bar IPC listener
    this._setupUsageListener();

    // Setup git changes badge polling
    this._setupGitChangesBadge();

    // Setup auto-update button
    this._setupAutoUpdate();
  }

  /**
   * Setup IPC listener for AI usage updates (generic, per-terminal)
   */
  _setupUsageListener() {
    // Listen for generic AI usage data (routed by toolId)
    this._addIpcListener(IPC.AI_USAGE_DATA, (event, data) => {
      // Only update if the data matches the currently displayed tool
      if (data.toolId === this._currentUsageTool) {
        // Only retry when there's no displayable data at all
        if (data.fiveHour === null && data.sevenDay === null && this._usageRetryCount < 3) {
          this._usageRetryCount++;
          if (this._usageRetryTimer) clearTimeout(this._usageRetryTimer);
          this._usageRetryTimer = setTimeout(() => {
            if (this._currentUsageTool) {
              ipcRenderer.send(IPC.LOAD_AI_USAGE, this._currentUsageTool);
            }
          }, 3000);
          return; // Don't update UI with error/empty data while retrying
        }
        this._usageRetryCount = 0;
        this._updateUsageBar(data);
      }
    });

    // Initial load will happen when update() is first called with terminal state
  }

  /**
   * Update usage bar UI with new data
   */
  _updateUsageBar(data) {
    const container = this.element.querySelector('.ai-usage-bars');
    if (!container) return;

    const sessionItem = container.querySelector('.usage-item.session');
    const weeklyItem = container.querySelector('.usage-item.weekly');

    if (data.error) {
      if (data.fiveHour || data.sevenDay) {
        // Error but cached data available - show cached data with warning tooltip
        container.title = this._getUsageRefreshTitle(`Warning: ${data.error}`, data.sourceLimitId);
        // Fall through to normal render path below
      } else {
        // No data at all - show N/A
        this._updateUsageItem(sessionItem, 0, 'N/A', '');
        this._updateUsageItem(weeklyItem, 0, 'N/A', '');
        container.title = this._getUsageRefreshTitle(`Error: ${data.error}`, data.sourceLimitId);
        return;
      }
    }

    // Update session (5-hour) bar
    const sessionUsage = data.fiveHour?.utilization || 0;
    const sessionReset = data.fiveHour?.resetsAt
      ? this._formatResetTime(data.fiveHour.resetsAt)
      : '';
    this._updateUsageItem(sessionItem, sessionUsage, `${Math.round(sessionUsage)}%`, sessionReset);

    // Update weekly (7-day) bar
    const weeklyUsage = data.sevenDay?.utilization || 0;
    const weeklyReset = data.sevenDay?.resetsAt
      ? this._formatResetTime(data.sevenDay.resetsAt)
      : '';
    this._updateUsageItem(weeklyItem, weeklyUsage, `${Math.round(weeklyUsage)}%`, weeklyReset);

    container.title = this._getUsageRefreshTitle('', data.sourceLimitId);
  }

  _setUsageToolIndicator(toolId) {
    const container = this.element?.querySelector('.ai-usage-bars');
    if (!container) return;
    const iconEl = container.querySelector('.usage-tool-icon');
    const nameEl = container.querySelector('.usage-tool-name');
    if (!iconEl || !nameEl) return;

    if (!toolId) {
      iconEl.innerHTML = '';
      nameEl.textContent = '';
      return;
    }

    const name = AI_TOOL_FULL_NAMES[toolId] || 'AI Tool';
    const icon = AI_TOOL_ICONS[toolId] || '';
    iconEl.innerHTML = icon;
    nameEl.textContent = name;
  }

  _getUsageRefreshTitle(prefix = '', sourceLimitId = null) {
    const name = AI_TOOL_FULL_NAMES[this._currentUsageTool] || 'AI Tool';
    const sourceLine = sourceLimitId ? `\nSource: ${sourceLimitId}` : '';
    if (prefix) {
      return `${prefix}\n${name} usage - Click to refresh${sourceLine}`;
    }
    return `${name} usage - Click to refresh${sourceLine}`;
  }

  /**
   * Update a single usage item
   */
  _updateUsageItem(item, usage, percentText, resetText) {
    if (!item) return;

    const fill = item.querySelector('.usage-bar-fill');
    const percent = item.querySelector('.usage-percent');
    const reset = item.querySelector('.usage-reset');

    if (fill) {
      fill.style.width = `${Math.min(usage, 100)}%`;
      fill.className = 'usage-bar-fill';
      if (usage >= 80) {
        fill.classList.add('critical');
      } else if (usage >= 50) {
        fill.classList.add('warning');
      }
    }

    if (percent) {
      percent.textContent = percentText;
    }

    if (reset && resetText) {
      reset.textContent = `(${resetText})`;
    } else if (reset) {
      reset.textContent = '';
    }
  }

  /**
   * Format reset time
   */
  _formatResetTime(isoString) {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diffMs = date.getTime() - now.getTime();

      if (diffMs < 0) return 'soon';

      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 60) {
        return `${diffMins}m`;
      }

      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) {
        const remainingMins = diffMins % 60;
        return `${diffHours}h ${remainingMins}m`;
      }

      const diffDays = Math.floor(diffHours / 24);
      const remainingHours = diffHours % 24;
      return `${diffDays}d ${remainingHours}h`;
    } catch {
      return '';
    }
  }

  /**
   * Setup git changes badge with .git directory watcher + fallback polling
   */
  _setupGitChangesBadge() {
    const state = require('./state');
    const pollChanges = async () => {
      // When source-control panel is already active on Changes tab, it owns
      // refresh cadence and emits optimistic counts to avoid duplicate polling.
      if (githubPanel.isChangesTabActive && githubPanel.isChangesTabActive()) {
        return;
      }
      const projectPath = state.getProjectPath();
      if (!projectPath) {
        this._updateGitChangesBadge(0);
        return;
      }
      try {
        const result = await ipcRenderer.invoke(IPC.LOAD_GIT_CHANGES, projectPath);
        if (!result.error) {
          this._updateGitChangesBadge(result.totalCount);
        }
      } catch {
        // Silently ignore
      }
    };

    // Initial poll
    pollChanges();

    // Fallback poll every 30 seconds (in case watcher misses something)
    this._gitChangesPollInterval = setInterval(pollChanges, 30000);

    // Optimistic sync from source-control operations (stage/commit/etc.).
    window.addEventListener('vibe:git-changes-count', (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const count = Number(detail?.count);
      if (Number.isFinite(count)) {
        this._updateGitChangesBadge(Math.max(0, count));
      }
    }, { signal: this._abortController.signal });

    // Re-setup on project change
    const unsubscribe = state.onProjectChange(() => {
      this._updateGitChangesBadge(0);
      pollChanges();
    });
    if (typeof unsubscribe === 'function') {
      this._stateCleanup.push(unsubscribe);
    }
  }

  /**
   * Update the git changes badge count
   */
  _updateGitChangesBadge(count) {
    const badge = this.element.querySelector('.git-changes-badge');
    if (!badge) return;

    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  /**
   * Setup auto-update button and IPC listeners
   */
  _setupAutoUpdate() {
    const btn = this.element.querySelector('.btn-upgrade');
    const badge = btn.querySelector('.upgrade-badge');
    let updateState = 'idle'; // idle | available | downloading | ready

    // Update available - show button with version badge
    this._addIpcListener(IPC.UPDATE_AVAILABLE, (event, data) => {
      updateState = 'available';
      btn.style.display = '';
      btn.className = 'toolbar-btn btn-upgrade';
      btn.title = `Update available: ${data.version}`;
      btn.disabled = false;
      badge.textContent = data.version.replace(/^v/, '');
      badge.style.display = 'flex';
      // Restore download arrow icon
      btn.querySelector('svg').innerHTML = '<path d="M12 5v14M19 12l-7 7-7-7"/>';
    });

    // Download progress
    this._addIpcListener(IPC.UPDATE_DOWNLOAD_PROGRESS, (event, data) => {
      updateState = 'downloading';
      btn.className = 'toolbar-btn btn-upgrade downloading';
      btn.title = `Downloading update... ${data.percent}%`;
      btn.disabled = true;
      badge.textContent = `${data.percent}%`;
    });

    // Download complete - switch to ready state
    this._addIpcListener(IPC.UPDATE_DOWNLOADED, () => {
      updateState = 'ready';
      btn.className = 'toolbar-btn btn-upgrade ready';
      btn.title = 'Update ready - Click to restart & install';
      btn.disabled = false;
      badge.textContent = '✓';
      // Swap icon to checkmark
      btn.querySelector('svg').innerHTML = '<polyline points="20 6 9 17 4 12"/>';
    });

    // Error - revert to available state
    this._addIpcListener(IPC.UPDATE_ERROR, () => {
      if (updateState === 'downloading') {
        updateState = 'available';
        btn.className = 'toolbar-btn btn-upgrade';
        btn.title = 'Download failed - Click to retry';
        btn.disabled = false;
        badge.textContent = '!';
        btn.querySelector('svg').innerHTML = '<path d="M12 5v14M19 12l-7 7-7-7"/>';
      }
    });

    // Click handler
    btn.addEventListener('click', () => {
      if (updateState === 'available') {
        ipcRenderer.send(IPC.DOWNLOAD_UPDATE);
        updateState = 'downloading';
        btn.className = 'toolbar-btn btn-upgrade downloading';
        btn.title = 'Downloading update...';
        btn.disabled = true;
        badge.textContent = '0%';
      } else if (updateState === 'ready') {
        ipcRenderer.send(IPC.INSTALL_UPDATE);
      }
    });
  }

  _startRename(tabElement) {
    const nameSpan = tabElement.querySelector('.tab-name');
    if (!nameSpan) return; // Already renaming or invalid structure
    
    const currentName = nameSpan.textContent;
    const terminalId = tabElement.dataset.terminalId;

    // Create input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-rename-input';
    input.value = currentName;

    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = () => {
      const newName = input.value.trim() || currentName;
      
      // Revert UI immediately to avoid stuck input
      const span = document.createElement('span');
      span.className = 'tab-name';
      span.textContent = newName;
      if (input.parentNode) {
        input.replaceWith(span);
      }

      this.manager.renameTerminal(terminalId, newName);
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        input.value = currentName;
        input.blur();
      }
    });
  }

  _showContextMenu(x, y, tabElement) {
    // Clear previous items
    this.contextMenu.innerHTML = '';
    
    // Rename option
    const renameItem = document.createElement('div');
    renameItem.className = 'terminal-context-menu-item';
    renameItem.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
      </svg>
      Rename
    `;
    renameItem.addEventListener('click', () => {
      this._startRename(tabElement);
      this._hideContextMenu();
    });
    
    // Close option
    const closeItem = document.createElement('div');
    closeItem.className = 'terminal-context-menu-item';
    closeItem.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
      Close
    `;
    closeItem.addEventListener('click', () => {
      const terminalId = tabElement.dataset.terminalId;
      this.manager.closeTerminal(terminalId);
      this._hideContextMenu();
    });

    this.contextMenu.appendChild(renameItem);
    this.contextMenu.appendChild(closeItem);

    // Position and show
    this.contextMenu.style.left = `${x}px`;
    this.contextMenu.style.top = `${y}px`;
    this.contextMenu.classList.add('visible');
    
    // Adjust position if out of bounds
    const rect = this.contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      this.contextMenu.style.left = `${window.innerWidth - rect.width - 5}px`;
    }
    if (rect.bottom > window.innerHeight) {
      this.contextMenu.style.top = `${window.innerHeight - rect.height - 5}px`;
    }
  }

  _hideContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.classList.remove('visible');
    }
  }

  _createTerminalAndFocus(options = {}) {
    this.manager.createTerminal(options)
      .then((terminalId) => {
        if (!terminalId) return;
        this.manager.setViewMode('tabs');
        this.manager.setActiveTerminal(terminalId);
      })
      .catch((err) => {
        console.error('Failed to create terminal:', err);
      });
  }

  _createShellMenu() {
    this.shellMenu = document.createElement('div');
    this.shellMenu.className = 'terminal-context-menu shell-menu';
    document.body.appendChild(this.shellMenu);

    // Hide menu on click elsewhere
    document.addEventListener('click', (e) => {
      const target = e.target instanceof Node ? e.target : null;
      const targetEl = e.target instanceof Element ? e.target : null;
      if ((!target || !this.shellMenu.contains(target)) && !targetEl?.classList.contains('btn-new-terminal')) {
        this._hideShellMenu();
      }
    }, { signal: this._abortController.signal });

    // Hide menu on scroll
    document.addEventListener('scroll', () => {
      this._hideShellMenu();
    }, { capture: true, signal: this._abortController.signal });
  }

  async _loadAvailableShells() {
    try {
      this.availableShells = await this.manager.getAvailableShells();
    } catch (err) {
      console.error('Failed to load available shells:', err);
      this.availableShells = [];
    }
  }

  _showShellMenu(x, y) {
    // Clear previous items
    this.shellMenu.innerHTML = '';

    // Add header
    const header = document.createElement('div');
    header.className = 'shell-menu-header';
    header.textContent = 'Select Shell';
    this.shellMenu.appendChild(header);

    // Add shell options
    if (this.availableShells.length === 0) {
      const noShells = document.createElement('div');
      noShells.className = 'terminal-context-menu-item';
      noShells.textContent = 'Loading...';
      noShells.style.opacity = '0.5';
      this.shellMenu.appendChild(noShells);

      // Try to reload shells
      this._loadAvailableShells().then(() => {
        if (this.shellMenu.classList.contains('visible')) {
          this._showShellMenu(x, y);
        }
      });
    } else {
      this.availableShells.forEach((shell, index) => {
        const item = document.createElement('div');
        item.className = 'terminal-context-menu-item';
        if (shell.isDefault) {
          item.classList.add('default');
        }

        // Shell icon based on type
        const icon = this._getShellIcon(shell.id);
        item.innerHTML = `
          ${icon}
          <span>${escapeHtml(shell.name)}</span>
          ${shell.isDefault ? '<span class="shell-default-badge">default</span>' : ''}
        `;

        item.addEventListener('click', () => {
          this._hideShellMenu();
          this._createTerminalAndFocus({ shell: shell.path });
        });

        this.shellMenu.appendChild(item);
      });
    }

    // Position and show
    this.shellMenu.style.left = `${x}px`;
    this.shellMenu.style.top = `${y}px`;
    this.shellMenu.classList.add('visible');

    // Adjust position if out of bounds
    const rect = this.shellMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      this.shellMenu.style.left = `${window.innerWidth - rect.width - 5}px`;
    }
    if (rect.bottom > window.innerHeight) {
      this.shellMenu.style.top = `${y - rect.height}px`;
    }
  }

  _hideShellMenu() {
    if (this.shellMenu) {
      this.shellMenu.classList.remove('visible');
    }
  }

  _getShellIcon(shellId) {
    const icons = {
      'zsh': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>',
      'bash': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>',
      'fish': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"></path><path d="M8 12h8"></path></svg>',
      'nu': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>',
      'powershell': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"></rect><polyline points="6 9 10 12 6 15"></polyline></svg>',
      'pwsh': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"></rect><polyline points="6 9 10 12 6 15"></polyline></svg>',
      'cmd': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"></rect><line x1="6" y1="12" x2="18" y2="12"></line></svg>',
      'gitbash': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
      'wsl': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>',
      'sh': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>'
    };
    return icons[shellId] || icons['sh'];
  }

}

module.exports = { TerminalTabBar };
