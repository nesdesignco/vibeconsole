/**
 * Saved Prompts Manager Module
 * Handles CRUD operations for saved prompts with dual storage (global + project)
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { IPC } = require('../shared/ipcChannels');

const EMPTY_PROMPTS = { prompts: [] };
const ALLOWED_UPDATE_FIELDS = ['title', 'content', 'category', 'favorite'];

/**
 * Initialize saved prompts manager
 */
function init(_window) {
  // Ensure global prompts file exists
  const globalPath = getGlobalPromptsPath();
  if (!fs.existsSync(globalPath)) {
    try {
      fs.writeFileSync(globalPath, JSON.stringify(EMPTY_PROMPTS, null, 2), 'utf8');
    } catch (err) {
      console.error('Error creating global saved-prompts.json:', err);
    }
  }
}

/**
 * Get global prompts file path
 */
function getGlobalPromptsPath() {
  return path.join(app.getPath('userData'), 'saved-prompts.json');
}

/**
 * Get project prompts file path (stored in .frame/ directory)
 */
function getProjectPromptsPath(projectPath) {
  if (!projectPath) return null;
  const framePath = path.join(projectPath, '.frame', 'saved-prompts.json');
  const oldPath = path.join(projectPath, 'saved-prompts.json');

  // Active migration: move old file to .frame/ if needed
  if (!fs.existsSync(framePath) && fs.existsSync(oldPath)) {
    try {
      const dir = path.dirname(framePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.renameSync(oldPath, framePath);
    } catch (err) {
      console.error('Error migrating saved-prompts.json to .frame/:', err);
      return oldPath; // Fallback to old path if migration fails
    }
  }

  return framePath;
}

/**
 * Load prompts from a file
 */
function loadPrompts(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading prompts from', filePath, err);
    // Backup corrupted file to prevent data loss on next save
    try {
      const backupPath = filePath + '.backup';
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(filePath, backupPath);
      }
    } catch (backupErr) {
      console.error('Error backing up corrupted file:', backupErr);
    }
  }
  return { prompts: [] };
}

/**
 * Save prompts to a file
 */
function savePrompts(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving prompts to', filePath, err);
    return false;
  }
}

/**
 * Generate unique prompt ID
 */
function generatePromptId() {
  return `prompt-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
}

/**
 * Get file path for a given scope
 */
function getPathForScope(scope, projectPath) {
  if (scope === 'global') {
    return getGlobalPromptsPath();
  }
  return getProjectPromptsPath(projectPath);
}

/**
 * Add a new prompt
 */
function addPrompt(scope, projectPath, promptData) {
  const filePath = getPathForScope(scope, projectPath);
  if (!filePath) return null;

  // Ensure directory exists (needed for .frame/ subdirectory)
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const data = loadPrompts(filePath);

  const newPrompt = {
    id: generatePromptId(),
    title: promptData.title || 'Untitled Prompt',
    content: promptData.content || '',
    category: promptData.category || 'general',
    favorite: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.prompts.push(newPrompt);

  if (savePrompts(filePath, data)) {
    return newPrompt;
  }
  return null;
}

/**
 * Update an existing prompt
 */
function updatePrompt(scope, projectPath, promptId, updates) {
  const filePath = getPathForScope(scope, projectPath);
  if (!filePath) return null;

  const data = loadPrompts(filePath);
  const index = data.prompts.findIndex(p => p.id === promptId);
  if (index === -1) return null;

  // Only allow whitelisted fields to prevent arbitrary field override
  const safeUpdates = {};
  for (const key of ALLOWED_UPDATE_FIELDS) {
    if (key in updates) safeUpdates[key] = updates[key];
  }

  Object.assign(data.prompts[index], safeUpdates, { updatedAt: new Date().toISOString() });

  if (savePrompts(filePath, data)) {
    return data.prompts[index];
  }
  return null;
}

/**
 * Delete a prompt
 */
function deletePrompt(scope, projectPath, promptId) {
  const filePath = getPathForScope(scope, projectPath);
  if (!filePath) return false;

  const data = loadPrompts(filePath);
  const index = data.prompts.findIndex(p => p.id === promptId);
  if (index === -1) return false;

  data.prompts.splice(index, 1);
  return savePrompts(filePath, data);
}

/**
 * Setup IPC handlers
 */
function setupIPC(ipcMain) {
  function safeSend(sender, channel, data) {
    if (!sender.isDestroyed()) sender.send(channel, data);
  }

  ipcMain.on(IPC.LOAD_SAVED_PROMPTS, (event, projectPath) => {
    const globalData = loadPrompts(getGlobalPromptsPath());
    const projectData = projectPath ? loadPrompts(getProjectPromptsPath(projectPath)) : { prompts: [] };

    safeSend(event.sender, IPC.SAVED_PROMPTS_DATA, {
      globalPrompts: globalData.prompts,
      projectPrompts: projectData.prompts
    });
  });

  ipcMain.on(IPC.ADD_SAVED_PROMPT, (event, { scope, projectPath, prompt }) => {
    const newPrompt = addPrompt(scope, projectPath, prompt);
    safeSend(event.sender, IPC.SAVED_PROMPT_UPDATED, {
      action: 'add',
      prompt: newPrompt,
      success: !!newPrompt
    });

    // Send updated data
    const globalData = loadPrompts(getGlobalPromptsPath());
    const projectData = projectPath ? loadPrompts(getProjectPromptsPath(projectPath)) : { prompts: [] };
    safeSend(event.sender, IPC.SAVED_PROMPTS_DATA, {
      globalPrompts: globalData.prompts,
      projectPrompts: projectData.prompts
    });
  });

  ipcMain.on(IPC.UPDATE_SAVED_PROMPT, (event, { scope, projectPath, promptId, updates }) => {
    const updatedPrompt = updatePrompt(scope, projectPath, promptId, updates);
    safeSend(event.sender, IPC.SAVED_PROMPT_UPDATED, {
      action: 'update',
      prompt: updatedPrompt,
      success: !!updatedPrompt
    });

    // Send updated data
    const globalData = loadPrompts(getGlobalPromptsPath());
    const projectData = projectPath ? loadPrompts(getProjectPromptsPath(projectPath)) : { prompts: [] };
    safeSend(event.sender, IPC.SAVED_PROMPTS_DATA, {
      globalPrompts: globalData.prompts,
      projectPrompts: projectData.prompts
    });
  });

  ipcMain.on(IPC.DELETE_SAVED_PROMPT, (event, { scope, projectPath, promptId }) => {
    const success = deletePrompt(scope, projectPath, promptId);
    safeSend(event.sender, IPC.SAVED_PROMPT_UPDATED, {
      action: 'delete',
      promptId,
      success
    });

    // Send updated data
    const globalData = loadPrompts(getGlobalPromptsPath());
    const projectData = projectPath ? loadPrompts(getProjectPromptsPath(projectPath)) : { prompts: [] };
    safeSend(event.sender, IPC.SAVED_PROMPTS_DATA, {
      globalPrompts: globalData.prompts,
      projectPrompts: projectData.prompts
    });
  });
}

module.exports = {
  init,
  setupIPC
};
