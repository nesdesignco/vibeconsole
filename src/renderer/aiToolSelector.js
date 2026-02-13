/**
 * AI Tool Selector Module
 * Manages UI for switching between AI coding tools (Claude Code, Codex CLI, etc.)
 */

const { ipcRenderer } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
const { escapeHtml } = require('./escapeHtml');

let currentTool = null;
let availableTools = {};
let onToolChangeCallback = null;

// Inline SVG icons for AI tools
const AI_TOOL_ICONS = {
  claude: `<svg class="ai-tool-icon" width="14" height="14" viewBox="0 0 100 100"><g transform="translate(50,50)" fill="currentColor"><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(0)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(32.7)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(65.5)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(98.2)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(130.9)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(163.6)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(196.4)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(229.1)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(261.8)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(294.5)"/><polygon points="-3.5,0 -2,-42 2,-42 3.5,0" transform="rotate(327.3)"/></g></svg>`,
  codex: `<svg class="ai-tool-icon" width="14" height="14" viewBox="0 0 721 721" fill="currentColor"><path d="M304.246 295.411V249.828C304.246 245.989 305.687 243.109 309.044 241.191L400.692 188.412C413.167 181.215 428.042 177.858 443.394 177.858C500.971 177.858 537.44 222.482 537.44 269.982C537.44 273.34 537.44 277.179 536.959 281.018L441.954 225.358C436.197 222 430.437 222 424.68 225.358L304.246 295.411ZM518.245 472.945V364.024C518.245 357.304 515.364 352.507 509.608 349.149L389.174 279.096L428.519 256.543C431.877 254.626 434.757 254.626 438.115 256.543L529.762 309.323C556.154 324.679 573.905 357.304 573.905 388.971C573.905 425.436 552.315 459.024 518.245 472.941V472.945ZM275.937 376.982L236.592 353.952C233.235 352.034 231.794 349.154 231.794 345.315V239.756C231.794 188.416 271.139 149.548 324.4 149.548C344.555 149.548 363.264 156.268 379.102 168.262L284.578 222.964C278.822 226.321 275.942 231.119 275.942 237.838V376.986L275.937 376.982ZM360.626 425.922L304.246 394.255V327.083L360.626 295.416L417.002 327.083V394.255L360.626 425.922ZM396.852 571.789C376.698 571.789 357.989 565.07 342.151 553.075L436.674 498.374C442.431 495.017 445.311 490.219 445.311 483.499V344.352L485.138 367.382C488.495 369.299 489.936 372.179 489.936 376.018V481.577C489.936 532.917 450.109 571.785 396.852 571.785V571.789ZM283.134 464.79L191.486 412.01C165.094 396.654 147.343 364.029 147.343 332.362C147.343 295.416 169.415 262.309 203.48 248.393V357.791C203.48 364.51 206.361 369.308 212.117 372.665L332.074 442.237L292.729 464.79C289.372 466.707 286.491 466.707 283.134 464.79ZM277.859 543.48C223.639 543.48 183.813 502.695 183.813 452.314C183.813 448.475 184.294 444.636 184.771 440.797L279.295 495.498C285.051 498.856 290.812 498.856 296.568 495.498L417.002 425.927V471.509C417.002 475.349 415.562 478.229 412.204 480.146L320.557 532.926C308.081 540.122 293.206 543.48 277.854 543.48H277.859ZM396.852 600.576C454.911 600.576 503.37 559.313 514.41 504.612C568.149 490.696 602.696 440.315 602.696 388.976C602.696 355.387 588.303 322.762 562.392 299.25C564.791 289.173 566.231 279.096 566.231 269.024C566.231 200.411 510.571 149.067 446.274 149.067C433.322 149.067 420.846 150.984 408.37 155.305C386.775 134.192 357.026 120.758 324.4 120.758C266.342 120.758 217.883 162.02 206.843 216.721C153.104 230.637 118.557 281.018 118.557 332.357C118.557 365.946 132.95 398.571 158.861 422.083C156.462 432.16 155.022 442.237 155.022 452.309C155.022 520.922 210.682 572.266 274.978 572.266C287.931 572.266 300.407 570.349 312.883 566.028C334.473 587.141 364.222 600.576 396.852 600.576Z"/></svg>`
};

/**
 * Initialize the AI tool selector
 */
async function init(onToolChange) {
  onToolChangeCallback = onToolChange;

  // Get initial config
  const config = await ipcRenderer.invoke(IPC.GET_AI_TOOL_CONFIG);
  currentTool = config.activeTool;
  availableTools = config.availableTools;

  // Setup UI
  setupSelector();
  updateUI();

  // Listen for tool changes from main process
  ipcRenderer.on(IPC.AI_TOOL_CHANGED, (event, tool) => {
    currentTool = tool;
    updateUI();
    if (onToolChangeCallback) {
      onToolChangeCallback(tool);
    }
  });
}

/**
 * Setup the selector dropdown
 */
function setupSelector() {
  const selector = document.getElementById('ai-tool-selector');
  if (!selector) return;

  const label = selector.querySelector('.ai-tool-dropdown-label');
  const menu = selector.querySelector('.ai-tool-dropdown-menu');
  if (!label || !menu) return;

  // Populate items
  menu.innerHTML = '';
  Object.values(availableTools).forEach(tool => {
    const item = document.createElement('div');
    item.className = 'ai-tool-dropdown-item';
    item.dataset.value = tool.id;
    const icon = AI_TOOL_ICONS[tool.id] || '';
    const name = tool.name.replace(' Code', '').replace(' CLI', '');
    item.innerHTML = `${icon}<span>${escapeHtml(name)}</span>`;
    menu.appendChild(item);
  });

  // Set current value
  if (currentTool) {
    const icon = AI_TOOL_ICONS[currentTool.id] || '';
    const name = currentTool.name.replace(' Code', '').replace(' CLI', '');
    label.innerHTML = `${icon}<span>${escapeHtml(name)}</span>`;
    const activeItem = menu.querySelector(`[data-value="${currentTool.id}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  // Toggle dropdown on click
  selector.addEventListener('click', (e) => {
    e.stopPropagation();
    selector.classList.toggle('open');
  });

  // Handle item click
  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.ai-tool-dropdown-item');
    if (!item) return;
    e.stopPropagation();

    const toolId = item.dataset.value;
    selector.classList.remove('open');

    const success = await ipcRenderer.invoke(IPC.SET_AI_TOOL, toolId);
    if (!success) {
      // Revert
      const icon = AI_TOOL_ICONS[currentTool.id] || '';
      const name = currentTool.name.replace(' Code', '').replace(' CLI', '');
      label.innerHTML = `${icon}<span>${escapeHtml(name)}</span>`;
    }
  });

  // Close on outside click
  document.addEventListener('click', () => {
    selector.classList.remove('open');
  });
}

/**
 * Update UI to reflect current tool
 */
function updateUI() {
  if (!currentTool) return;

  // Update selector
  const selector = document.getElementById('ai-tool-selector');
  if (selector) {
    const label = selector.querySelector('.ai-tool-dropdown-label');
    if (label) {
      const icon = AI_TOOL_ICONS[currentTool.id] || '';
      const name = currentTool.name.replace(' Code', '').replace(' CLI', '');
      label.innerHTML = `${icon}<span>${escapeHtml(name)}</span>`;
    }
    const menu = selector.querySelector('.ai-tool-dropdown-menu');
    if (menu) {
      menu.querySelectorAll('.ai-tool-dropdown-item').forEach(item => {
        item.classList.toggle('active', item.dataset.value === currentTool.id);
      });
    }
  }

  // Update start button text
  const startBtn = document.getElementById('btn-start-ai');
  if (startBtn) {
    startBtn.textContent = `Start ${currentTool.name}`;
  }

  // Show/hide plugins panel based on tool support
  const pluginsPanel = document.getElementById('plugins-panel');
  if (pluginsPanel && !currentTool.supportsPlugins) {
    // Could hide or show a message - for now just leave it
  }
}

/**
 * Get the current active tool
 */
function getCurrentTool() {
  return currentTool;
}

/**
 * Get the start command for current tool
 */
function getStartCommand() {
  return currentTool ? currentTool.command : 'claude';
}

/**
 * Get a specific command for current tool
 */
function getCommand(action) {
  if (!currentTool || !currentTool.commands) return null;
  return currentTool.commands[action] || null;
}

/**
 * Check if current tool supports a feature
 */
function supportsFeature(feature) {
  if (!currentTool) return false;

  switch (feature) {
    case 'plugins':
      return currentTool.supportsPlugins;
    case 'init':
      return !!currentTool.commands.init;
    case 'commit':
      return !!currentTool.commands.commit;
    default:
      return false;
  }
}

module.exports = {
  init,
  getCurrentTool,
  getStartCommand,
  getCommand,
  supportsFeature,
  AI_TOOL_ICONS
};
