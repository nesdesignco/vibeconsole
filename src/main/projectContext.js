/**
 * Restricted VibeConsole project-context status checks.
 * Exposes root-file presence only; it never returns contents or writes files.
 */

const fs = require('fs');
const path = require('path');
const { IPC } = require('../shared/ipcChannels');

function resolveProjectRoot(projectPath) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error('A valid absolute project path is required');
  }

  const resolved = fs.realpathSync(projectPath);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('Project path must be a directory');
  }
  return resolved;
}

function isRootFile(projectRoot, fileName) {
  const candidate = path.join(projectRoot, fileName);
  try {
    return fs.statSync(candidate).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function getProjectContextStatus(projectPath) {
  try {
    const projectRoot = resolveProjectRoot(projectPath);
    const files = {
      structureJson: isRootFile(projectRoot, 'STRUCTURE.json'),
      projectNotesMd: isRootFile(projectRoot, 'PROJECT_NOTES.md'),
      tasksJson: isRootFile(projectRoot, 'tasks.json'),
      agentsMd: isRootFile(projectRoot, 'AGENTS.md'),
      claudeMd: isRootFile(projectRoot, 'CLAUDE.md')
    };
    const missingCoreFiles = [];
    if (!files.structureJson) missingCoreFiles.push('STRUCTURE.json');
    if (!files.projectNotesMd) missingCoreFiles.push('PROJECT_NOTES.md');
    if (!files.tasksJson) missingCoreFiles.push('tasks.json');

    return {
      success: true,
      files,
      missingCoreFiles,
      mode: missingCoreFiles.length > 0 ? 'initialize' : 'audit'
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Could not inspect the project context',
      files: {
        structureJson: false,
        projectNotesMd: false,
        tasksJson: false,
        agentsMd: false,
        claudeMd: false
      },
      missingCoreFiles: ['STRUCTURE.json', 'PROJECT_NOTES.md', 'tasks.json'],
      mode: 'initialize'
    };
  }
}

function setupIPC(ipcMain) {
  ipcMain.handle(IPC.GET_PROJECT_CONTEXT_STATUS, (_event, projectPath) => {
    return getProjectContextStatus(projectPath);
  });
}

module.exports = {
  resolveProjectRoot,
  getProjectContextStatus,
  setupIPC
};
