/**
 * Dialogs Module
 * Handles system dialogs - folder picker, file dialogs
 */

const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const { IPC } = require('../shared/ipcChannels');

let mainWindow = null;
let onProjectSelected = null;

/**
 * Initialize dialogs module
 */
function init(window, callback) {
  mainWindow = window;
  onProjectSelected = callback;
}

/**
 * Show folder picker dialog
 */
async function showFolderPicker(event) {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const selectedPath = result.filePaths[0];

    if (onProjectSelected) {
      onProjectSelected(selectedPath);
    }

    event.sender.send(IPC.PROJECT_SELECTED, selectedPath);
    return selectedPath;
  }

  return null;
}

/**
 * Show new project dialog
 */
async function showNewProjectDialog(event, projectName) {
  const name = typeof projectName === 'string' ? projectName.trim() : '';
  if (!name) {
    return { error: 'Project name is required' };
  }

  if (/[/\\:*?"<>|]/.test(name) || name === '.' || name === '..') {
    return { error: 'Project name contains invalid characters' };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Parent Folder for New Project',
    buttonLabel: 'Select Parent Folder'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const parentPath = result.filePaths[0];
    const projectPath = path.join(parentPath, name);

    if (fs.existsSync(projectPath)) {
      return { error: 'A folder with this name already exists in the selected location' };
    }

    try {
      fs.mkdirSync(projectPath, { recursive: false });
    } catch (err) {
      return { error: `Failed to create project folder: ${err.message}` };
    }

    if (onProjectSelected) {
      onProjectSelected(projectPath);
    }

    event.sender.send(IPC.PROJECT_SELECTED, projectPath);
    return { projectPath };
  }

  return { canceled: true };
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  ipcMain.on(IPC.SELECT_PROJECT_FOLDER, async (event) => {
    await showFolderPicker(event);
  });

  ipcMain.handle(IPC.CREATE_NEW_PROJECT, async (event, payload = {}) => {
    return await showNewProjectDialog(event, payload.projectName);
  });
}

module.exports = {
  init,
  showFolderPicker,
  showNewProjectDialog,
  setupIPC
};
