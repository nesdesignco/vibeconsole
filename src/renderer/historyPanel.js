/**
 * History Panel Module
 * Toggle, load, render prompt history
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { registerPanel, showPanel, hidePanel, togglePanel } = require('./panelCoordinator');

let historyPanel = null;
let historyContent = null;
let historyVisible = false;
let onToggleCallback = null;
let lastHistoryToggleAt = 0;

const PANEL_ID = 'history';
const HISTORY_TOGGLE_DEDUP_MS = 150;

/**
 * Initialize history panel
 */
function init(panelId, contentId, onToggle) {
  historyPanel = document.getElementById(panelId);
  historyContent = document.getElementById(contentId);
  onToggleCallback = onToggle;

  registerPanel(PANEL_ID, {
    show: showHistoryPanelRaw,
    hide: hideHistoryPanelRaw,
    isVisible: isHistoryVisible
  });

  setupIPC();
}

/**
 * Check if history panel is visible
 */
function isHistoryVisible() {
  return historyVisible;
}

/**
 * Toggle history panel visibility
 */
function notifyToggle() {
  if (onToggleCallback) {
    onToggleCallback(historyVisible);
  }
}

function showHistoryPanelRaw() {
  if (!historyPanel || historyVisible) return historyVisible;
  historyVisible = true;
  historyPanel.classList.add('visible');
  loadPromptHistory();
  notifyToggle();
  return historyVisible;
}

function hideHistoryPanelRaw() {
  if (!historyPanel || !historyVisible) return historyVisible;
  historyVisible = false;
  historyPanel.classList.remove('visible');
  notifyToggle();
  return historyVisible;
}

function showHistoryPanel() {
  return showPanel(PANEL_ID);
}

function hideHistoryPanel() {
  return hidePanel(PANEL_ID);
}

function toggleHistoryPanel() {
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if ((now - lastHistoryToggleAt) < HISTORY_TOGGLE_DEDUP_MS) return historyVisible;
  lastHistoryToggleAt = now;

  return togglePanel(PANEL_ID);
}

/**
 * Load prompt history from file
 */
function loadPromptHistory() {
  ipcRenderer.send(IPC.LOAD_PROMPT_HISTORY);
}

/**
 * Render prompt history data
 */
function renderPromptHistory(historyData) {
  historyContent.innerHTML = '';

  if (!historyData || historyData.trim() === '') {
    historyContent.innerHTML = '<div class="history-empty-state">No history yet</div>';
    return;
  }

  const lines = historyData.trim().split('\n');

  // Reverse to show newest first
  lines.reverse().forEach(line => {
    const match = line.match(/\[(.*?)\]\s+(.*)/);
    if (match) {
      const timestamp = match[1];
      const command = match[2];

      const item = document.createElement('div');
      item.className = 'history-item';

      const ts = document.createElement('div');
      ts.className = 'history-timestamp';
      ts.textContent = new Date(timestamp).toLocaleString();

      const cmd = document.createElement('div');
      cmd.className = 'history-command';
      cmd.textContent = command;

      item.appendChild(ts);
      item.appendChild(cmd);
      historyContent.appendChild(item);
    }
  });
}

/**
 * Setup IPC listeners
 */
function setupIPC() {
  ipcRenderer.on(IPC.PROMPT_HISTORY_DATA, (event, data) => {
    renderPromptHistory(data);
  });

  ipcRenderer.on(IPC.TOGGLE_HISTORY_PANEL, () => {
    toggleHistoryPanel();
  });
}

module.exports = {
  init,
  isHistoryVisible,
  showHistoryPanel,
  hideHistoryPanel,
  toggleHistoryPanel,
  loadPromptHistory
};
