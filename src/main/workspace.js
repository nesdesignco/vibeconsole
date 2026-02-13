/**
 * Workspace Module
 * Manages workspace configuration in ~/.frame/workspaces.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { IPC } = require('../shared/ipcChannels');

const WORKSPACE_DIR = '.frame';
const WORKSPACE_FILE = 'workspaces.json';
const FRAME_VERSION = '1.0';

let workspaceDir = null;
let workspacePath = null;
let _cachedWorkspace = null; // In-memory cache to prevent read-modify-write races

/**
 * Initialize workspace module
 */
function init(app, _window) {
  workspaceDir = path.join(os.homedir(), WORKSPACE_DIR);
  workspacePath = path.join(workspaceDir, WORKSPACE_FILE);
  ensureWorkspaceDir();
}

/**
 * Ensure workspace directory and file exist
 */
function ensureWorkspaceDir() {
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  if (!fs.existsSync(workspacePath)) {
    const defaultWorkspace = createDefaultWorkspace();
    saveWorkspace(defaultWorkspace);
  }
}

/**
 * Create default workspace structure
 */
function createDefaultWorkspace() {
  return {
    version: FRAME_VERSION,
    activeWorkspace: 'default',
    workspaces: {
      default: {
        name: 'Default Workspace',
        createdAt: new Date().toISOString(),
        projects: []
      }
    }
  };
}

/**
 * Load workspace from file
 */
function loadWorkspace() {
  if (_cachedWorkspace) return _cachedWorkspace;
  try {
    const data = fs.readFileSync(workspacePath, 'utf8');
    _cachedWorkspace = JSON.parse(data);
    return _cachedWorkspace;
  } catch (err) {
    console.error('Error loading workspace:', err);
    _cachedWorkspace = createDefaultWorkspace();
    return _cachedWorkspace;
  }
}

/**
 * Save workspace to file
 */
function saveWorkspace(data) {
  try {
    const tempPath = workspacePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, workspacePath);
    _cachedWorkspace = data;
  } catch (err) {
    console.error('Error saving workspace:', err);
  }
}

/**
 * Get projects from active workspace
 */
function getProjects() {
  const workspace = loadWorkspace();
  const active = workspace.activeWorkspace;
  return workspace.workspaces[active]?.projects || [];
}

/**
 * Add project to workspace
 */
function addProject(projectPath, name) {
  const workspace = loadWorkspace();
  const active = workspace.activeWorkspace;

  // Check if already exists
  const exists = workspace.workspaces[active].projects.some(
    p => p.path === projectPath
  );
  if (exists) return false;

  workspace.workspaces[active].projects.push({
    path: projectPath,
    name: name || path.basename(projectPath),
    addedAt: new Date().toISOString(),
    lastOpenedAt: null
  });

  saveWorkspace(workspace);
  return true;
}

/**
 * Remove project from workspace
 */
function removeProject(projectPath) {
  const workspace = loadWorkspace();
  const active = workspace.activeWorkspace;

  workspace.workspaces[active].projects =
    workspace.workspaces[active].projects.filter(p => p.path !== projectPath);

  saveWorkspace(workspace);
}

/**
 * Update project's last opened timestamp
 */
function updateProjectLastOpened(projectPath) {
  const workspace = loadWorkspace();
  const active = workspace.activeWorkspace;

  const project = workspace.workspaces[active].projects.find(
    p => p.path === projectPath
  );
  if (project) {
    project.lastOpenedAt = new Date().toISOString();
    saveWorkspace(workspace);
  }
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  ipcMain.on(IPC.LOAD_WORKSPACE, (event) => {
    const projects = getProjects();
    if (!event.sender.isDestroyed()) event.sender.send(IPC.WORKSPACE_DATA, projects);
  });

  ipcMain.on(IPC.ADD_PROJECT_TO_WORKSPACE, (event, { projectPath, name }) => {
    addProject(projectPath, name);
    const projects = getProjects();
    if (!event.sender.isDestroyed()) event.sender.send(IPC.WORKSPACE_UPDATED, projects);
  });

  ipcMain.on(IPC.REMOVE_PROJECT_FROM_WORKSPACE, (event, projectPath) => {
    removeProject(projectPath);
    const projects = getProjects();
    if (!event.sender.isDestroyed()) event.sender.send(IPC.WORKSPACE_UPDATED, projects);
  });
}

module.exports = {
  init,
  loadWorkspace,
  getProjects,
  addProject,
  removeProject,
  updateProjectLastOpened,
  setupIPC
};
