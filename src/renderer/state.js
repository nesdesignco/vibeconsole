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
 * Request new project creation
 */
async function createNewProject() {
  const rawName = window.prompt('New project name');
  if (rawName === null) return; // User canceled

  const projectName = rawName.trim();
  if (!projectName) {
    window.alert('Project name cannot be empty.');
    return;
  }

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
