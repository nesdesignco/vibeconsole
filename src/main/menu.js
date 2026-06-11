/**
 * Application Menu Module
 * Defines menu structure and handlers
 * Supports dynamic menu based on active AI tool
 */

const { Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { IPC } = require('../shared/ipcChannels');
const autoUpdaterModule = require('./autoUpdater');

let mainWindow = null;
let appPath = null;
let aiToolManager = null;

function checkForUpdatesFromMenu() {
  // Open the modal first so the user immediately sees a "checking" state,
  // then trigger the check. The autoUpdater module sends its own UPDATE_CHECKING
  // event which the modal subscribes to.
  autoUpdaterModule.requestOpenModal();
  autoUpdaterModule.triggerManualCheck().catch(() => {
    /* errors are surfaced via UPDATE_ERROR */
  });
}

/**
 * Initialize menu module
 */
function init(window, app, toolManager) {
  mainWindow = window;
  appPath = app.getPath('userData');
  aiToolManager = toolManager;
}

/**
 * Get menu template based on active AI tool
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function getMenuTemplate() {
  const activeTool = aiToolManager ? aiToolManager.getActiveTool() : {
    menuLabel: 'AI Commands',
    command: 'claude',
    commands: {}
  };

  const aiCommandsSubmenu = buildAICommandsSubmenu(activeTool);

  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    {
      label: activeTool.menuLabel,
      submenu: aiCommandsSubmenu
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => toggleSidebar()
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  // macOS app menu
  if (process.platform === 'darwin') {
    /** @type {import('electron').MenuItemConstructorOptions[]} */
    const macAppSubmenu = [
      { role: 'about' },
      { type: 'separator' },
      {
        label: 'Check for Updates…',
        click: checkForUpdatesFromMenu
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ];

    template.unshift({
      label: 'Vibe Console',
      submenu: macAppSubmenu
    });
  }

  return template;
}

/**
 * Build AI commands submenu based on active tool
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function buildAICommandsSubmenu(tool) {
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const submenu = [];

  // Tool-specific commands
  if (tool.commands.init) {
    submenu.push({
      label: `Initialize Project (${tool.commands.init})`,
      accelerator: 'CmdOrCtrl+I',
      click: () => sendCommand(tool.commands.init)
    });
  }

  if (tool.commands.commit) {
    submenu.push({
      label: `Commit Changes (${tool.commands.commit})`,
      accelerator: 'CmdOrCtrl+Shift+C',
      click: () => sendCommand(tool.commands.commit)
    });
  }

  if (tool.commands.review) {
    submenu.push({
      label: `Review (${tool.commands.review})`,
      click: () => sendCommand(tool.commands.review)
    });
  }

  // Codex-specific commands
  if (tool.commands.model) {
    submenu.push({
      label: `Switch Model (${tool.commands.model})`,
      click: () => sendCommand(tool.commands.model)
    });
  }

  if (tool.commands.permissions) {
    submenu.push({
      label: `Permissions (${tool.commands.permissions})`,
      click: () => sendCommand(tool.commands.permissions)
    });
  }

  if (tool.commands.help) {
    submenu.push({
      label: `Help (${tool.commands.help})`,
      click: () => sendCommand(tool.commands.help)
    });
  }

  submenu.push({ type: 'separator' });

  // Start command
  submenu.push({
    label: `Start ${tool.name}`,
    accelerator: 'CmdOrCtrl+K',
    click: () => sendCommand(tool.command)
  });

  submenu.push({ type: 'separator' });

  // History commands (universal)
  submenu.push({
    label: 'Toggle Prompt History Panel',
    accelerator: 'CmdOrCtrl+Shift+H',
    click: () => toggleHistoryPanel()
  });

  submenu.push({
    label: 'Open History File',
    accelerator: 'CmdOrCtrl+H',
    click: () => openHistoryFile()
  });

  // AI Tool switcher
  if (aiToolManager) {
    submenu.push({ type: 'separator' });
    submenu.push({
      label: 'Switch AI Tool...',
      submenu: buildToolSwitcherSubmenu()
    });
  }

  return submenu;
}

/**
 * Build tool switcher submenu
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function buildToolSwitcherSubmenu() {
  const tools = aiToolManager.getAvailableTools();
  const activeTool = aiToolManager.getActiveTool();

  return Object.values(tools).map(tool => ({
    label: tool.name,
    type: 'radio',
    checked: tool.id === activeTool.id,
    click: () => {
      aiToolManager.setActiveTool(tool.id);
      // Rebuild menu with new tool
      createMenu();
    }
  }));
}

/**
 * Send command to terminal
 */
function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.RUN_COMMAND, command);
  }
}

/**
 * Toggle history panel
 */
function toggleHistoryPanel() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.TOGGLE_HISTORY_PANEL);
  }
}

/**
 * Toggle sidebar visibility
 */
function toggleSidebar() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.TOGGLE_SIDEBAR);
  }
}

/**
 * Open history file in default editor
 */
function openHistoryFile() {
  const logPath = path.join(appPath, 'prompts-history.txt');

  // Create file if it doesn't exist
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '# Prompt History\n\n', 'utf8');
  }

  shell.openPath(logPath);
}

/**
 * Create and set application menu
 */
function createMenu() {
  const template = getMenuTemplate();
  const builtMenu = Menu.buildFromTemplate(/** @type {import('electron').MenuItemConstructorOptions[]} */ (template));
  Menu.setApplicationMenu(builtMenu);
  return builtMenu;
}

module.exports = {
  init,
  createMenu,
  getMenuTemplate
};
