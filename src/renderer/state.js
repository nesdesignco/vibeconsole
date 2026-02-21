/**
 * Application State Module
 * Manages project path and UI state
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');

let currentProjectPath = null;
let onProjectChangeCallbacks = [];
let multiTerminalUI = null; // Reference to MultiTerminalUI instance

// UI Elements
let startClaudeBtn = null;
let fileExplorerHeader = null;

/**
 * Initialize state module
 */
function init(elements) {
  startClaudeBtn = elements.startClaudeBtn || document.getElementById('btn-start-ai');
  fileExplorerHeader = elements.fileExplorerHeader || document.getElementById('file-explorer-header');

  setupIPC();
}

/**
 * Get current project path
 */
function getProjectPath() {
  return currentProjectPath;
}

/**
 * Set MultiTerminalUI reference for terminal session management
 */
function setMultiTerminalUI(ui) {
  multiTerminalUI = ui;
}

/**
 * Set project path and switch terminal session
 */
function setProjectPath(path) {
  const previousPath = currentProjectPath;
  currentProjectPath = path;
  updateProjectUI();

  // Switch terminal session if MultiTerminalUI is available
  if (multiTerminalUI) {
    // Switch to the new project's terminals
    multiTerminalUI.setCurrentProject(path);
  }

  // Notify listeners
  onProjectChangeCallbacks.forEach(cb => cb(path, previousPath));
}

/**
 * Register callback for project change
 */
function onProjectChange(callback) {
  onProjectChangeCallbacks.push(callback);
  return () => {
    onProjectChangeCallbacks = onProjectChangeCallbacks.filter((cb) => cb !== callback);
  };
}

/**
 * Update project UI elements
 */
function updateProjectUI() {
  if (currentProjectPath) {
    if (startClaudeBtn) {
      startClaudeBtn.disabled = false;
    }
    if (fileExplorerHeader) {
      fileExplorerHeader.style.display = 'block';
    }
  } else {
    if (startClaudeBtn) {
      startClaudeBtn.disabled = true;
    }
    if (fileExplorerHeader) {
      fileExplorerHeader.style.display = 'none';
    }
  }
}

/**
 * Request folder selection
 */
function selectProjectFolder() {
  ipcRenderer.send(IPC.SELECT_PROJECT_FOLDER);
}

/**
 * Show a custom prompt dialog (window.prompt is unreliable in Electron sandbox)
 */
function showPromptDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:20px;min-width:320px;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'color:var(--text-primary);font-size:13px;margin-bottom:12px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:13px;outline:none;';
    input.addEventListener('focus', () => { input.style.borderColor = 'var(--accent-primary)'; });
    input.addEventListener('blur', () => { input.style.borderColor = 'var(--border-default)'; });

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn';
    cancelBtn.setAttribute('data-variant', 'ghost');

    const okBtn = document.createElement('button');
    okBtn.textContent = 'Create';
    okBtn.className = 'btn';
    okBtn.setAttribute('data-variant', 'primary');

    const cleanup = (value) => {
      overlay.remove();
      resolve(value);
    };

    cancelBtn.addEventListener('click', () => cleanup(null));
    okBtn.addEventListener('click', () => cleanup(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cleanup(input.value);
      if (e.key === 'Escape') cleanup(null);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

    actions.append(cancelBtn, okBtn);
    box.append(label, input, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
  });
}

/**
 * Request new project creation
 */
async function createNewProject() {
  const rawName = await showPromptDialog('New project name');
  if (rawName === null) return; // User canceled

  const projectName = rawName.trim();
  if (!projectName) return;

  try {
    const result = await ipcRenderer.invoke(IPC.CREATE_NEW_PROJECT, { projectName });
    if (result?.error) {
      window.alert(`Could not create project: ${result.error}`);
    }
  } catch (err) {
    window.alert(`Could not create project: ${err.message}`);
  }
}

/**
 * Setup IPC listeners
 */
function setupIPC() {
  ipcRenderer.on(IPC.PROJECT_SELECTED, (event, projectPath) => {
    setProjectPath(projectPath);
    // Terminal session switching is now handled by setProjectPath via multiTerminalUI
  });
}

module.exports = {
  init,
  getProjectPath,
  setProjectPath,
  setMultiTerminalUI,
  onProjectChange,
  selectProjectFolder,
  createNewProject
};
