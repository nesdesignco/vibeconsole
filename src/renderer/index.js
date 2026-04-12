/**
 * Renderer Entry Point
 * Initializes all UI modules and sets up event handlers
 */

const terminal = require('./terminal');
const fileTreeUI = require('./fileTreeUI');
const historyPanel = require('./historyPanel');
const pluginsPanel = require('./pluginsPanel');
const githubPanel = require('./githubPanel');
const state = require('./state');
const projectListUI = require('./projectListUI');
const editor = require('./editor');
const sidebarResize = require('./sidebarResize');
const aiToolSelector = require('./aiToolSelector');
const savedPromptsPanel = require('./savedPromptsPanel');
const { createToast } = require('./toast');
const { ipcRenderer, pathApi } = require('./electronBridge');
const { IPC } = require('../shared/ipcChannels');
let _rendererInitialized = false;
let _startToast = null;

let _lastSidebarToggleAt = 0;
let _autoCollapsedRightPanel = null;
let _rightPanelResizeTimer = null;
let _rightPanelResizeObserver = null;
let _rightPanelClassObserver = null;

const RIGHT_PANEL_COLLAPSE_BUFFER = 12;
const RIGHT_PANEL_RESTORE_BUFFER = 64;
const DEFAULT_TERMINAL_MIN_WIDTH = 620;

function toggleSidebarSafe() {
  // If both a menu accelerator and a DOM keydown handler fire, avoid double-toggle.
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if ((now - _lastSidebarToggleAt) < 150) return;
  _lastSidebarToggleAt = now;

  sidebarResize.toggle();
  terminal.fitTerminal();
}

// Expose layout toggle for renderer modules that should not depend on index.js directly.
window.toggleSidebar = toggleSidebarSafe;

function getRightPanelDescriptors() {
  return [
    { id: 'plugins-panel', panel: pluginsPanel },
    { id: 'github-panel', panel: githubPanel },
    { id: 'saved-prompts-panel', panel: savedPromptsPanel }
  ].map((descriptor) => ({
    ...descriptor,
    element: document.getElementById(descriptor.id)
  }));
}

function getVisibleRightPanel() {
  return getRightPanelDescriptors().find(({ panel }) => panel.isVisible());
}

function getCssPixelValue(element, propertyName, fallback = 0) {
  if (!element) return fallback;
  const value = parseFloat(window.getComputedStyle(element).getPropertyValue(propertyName));
  return Number.isFinite(value) ? value : fallback;
}

function getPanelTargetWidth(panelElement) {
  if (!panelElement) return 0;
  const panelWidth = getCssPixelValue(panelElement, '--panel-width', 0);
  return panelWidth || panelElement.getBoundingClientRect().width;
}

function getRequiredMainContentWidth(panelElement, buffer) {
  const terminalContainer = document.getElementById('terminal-container');
  if (!terminalContainer || !panelElement) return 0;

  const terminalStyle = window.getComputedStyle(terminalContainer);
  const terminalMinWidth = parseFloat(terminalStyle.minWidth) || DEFAULT_TERMINAL_MIN_WIDTH;
  const terminalMargins = (parseFloat(terminalStyle.marginLeft) || 0) + (parseFloat(terminalStyle.marginRight) || 0);

  return terminalMinWidth + terminalMargins + getPanelTargetWidth(panelElement) + buffer;
}

function showRightPanel(panelToShow) {
  getRightPanelDescriptors().forEach(({ panel }) => {
    if (panel === panelToShow) return;
    panel.hide();
  });
  panelToShow.show();
}

function syncRightPanelForAvailableWidth() {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return;

  const availableWidth = mainContent.clientWidth;
  const visibleRightPanel = getVisibleRightPanel();

  if (_autoCollapsedRightPanel) {
    if (visibleRightPanel?.element) {
      const visibleCollapseWidth = getRequiredMainContentWidth(
        visibleRightPanel.element,
        RIGHT_PANEL_COLLAPSE_BUFFER
      );
      if (availableWidth < visibleCollapseWidth) {
        _autoCollapsedRightPanel = { panel: visibleRightPanel.panel };
        visibleRightPanel.panel.hide();
      } else {
        _autoCollapsedRightPanel = null;
      }
      return;
    }

    const autoCollapsedDescriptor = getRightPanelDescriptors()
      .find(({ panel }) => panel === _autoCollapsedRightPanel.panel);
    if (!autoCollapsedDescriptor?.element) {
      _autoCollapsedRightPanel = null;
      return;
    }

    const restoreWidth = getRequiredMainContentWidth(
      autoCollapsedDescriptor.element,
      RIGHT_PANEL_RESTORE_BUFFER
    );
    if (availableWidth >= restoreWidth) {
      showRightPanel(autoCollapsedDescriptor.panel);
      _autoCollapsedRightPanel = null;
      return;
    }
    return;
  }

  if (!visibleRightPanel?.element) return;

  const collapseWidth = getRequiredMainContentWidth(
    visibleRightPanel.element,
    RIGHT_PANEL_COLLAPSE_BUFFER
  );
  if (availableWidth < collapseWidth) {
    _autoCollapsedRightPanel = { panel: visibleRightPanel.panel };
    visibleRightPanel.panel.hide();
  }
}

function scheduleRightPanelWidthSync() {
  if (_rightPanelResizeTimer) clearTimeout(_rightPanelResizeTimer);
  _rightPanelResizeTimer = setTimeout(() => {
    _rightPanelResizeTimer = null;
    syncRightPanelForAvailableWidth();
  }, 80);
}

function setupResponsiveRightPanelCollapse() {
  if (_rightPanelResizeObserver || _rightPanelClassObserver) return;

  const mainContent = document.getElementById('main-content');
  if (mainContent && typeof ResizeObserver !== 'undefined') {
    _rightPanelResizeObserver = new ResizeObserver(scheduleRightPanelWidthSync);
    _rightPanelResizeObserver.observe(mainContent);
  }

  const panelElements = getRightPanelDescriptors()
    .map(({ element }) => element)
    .filter(Boolean);
  if (panelElements.length && typeof MutationObserver !== 'undefined') {
    _rightPanelClassObserver = new MutationObserver(scheduleRightPanelWidthSync);
    panelElements.forEach((element) => {
      _rightPanelClassObserver.observe(element, {
        attributes: true,
        attributeFilter: ['class']
      });
    });
  }

  syncRightPanelForAvailableWidth();
  window.addEventListener('resize', scheduleRightPanelWidthSync);
}

/**
 * Initialize all modules
 */
function init() {
  if (_rendererInitialized) return;
  _rendererInitialized = true;

  // Initialize terminal
  let multiTerminalUI;
  try {
    multiTerminalUI = terminal.initTerminal('terminal');
    const terminalContainer = document.getElementById('terminal-container');
    if (terminalContainer) {
      _startToast = createToast(terminalContainer);
    }
  } catch (err) {
    console.error('Failed to initialize terminal:', err);
    return;
  }

  // Initialize state management
  try {
    state.init({
      startClaudeBtn: document.getElementById('btn-start-ai'),
      fileExplorerHeader: document.getElementById('file-explorer-header')
    });
  } catch (err) {
    console.error('Failed to initialize state:', err);
  }

  // Initialize AI tool selector
  try {
    aiToolSelector.init(() => {
      // Tool change handled by selector module
    });
  } catch (err) {
    console.error('Failed to initialize AI tool selector:', err);
  }

  // Connect state with multiTerminalUI for project-terminal session management
  state.setMultiTerminalUI(multiTerminalUI);

  // Initialize project list UI
  try {
    projectListUI.init('projects-list', (projectPath) => {
      state.setProjectPath(projectPath);
    });
    projectListUI.loadProjects();
  } catch (err) {
    console.error('Failed to initialize project list:', err);
  }

  // Initialize file tree UI
  try {
    fileTreeUI.init('file-tree', state.getProjectPath);
    fileTreeUI.setProjectPathGetter(state.getProjectPath);
  } catch (err) {
    console.error('Failed to initialize file tree:', err);
  }

  // Initialize editor with file tree refresh callback
  try {
    editor.init(() => {
      fileTreeUI.refreshFileTree();
    });
  } catch (err) {
    console.error('Failed to initialize editor:', err);
  }

  // Connect file tree clicks to editor
  fileTreeUI.setOnFileClick((filePath, source) => {
    editor.openFile(filePath, source);
  });

  // Connect terminal file path links to editor
  const manager = terminal.getTerminal();
  if (manager) {
    manager.onFilePathActivate = (filePath, line, col) => {
      const projectPath = state.getProjectPath();
      if (!projectPath) return;

      // Resolve path: strip leading ./ then join with project path if relative
      let resolved = filePath.replace(/^\.\//, '');
      if (!resolved.startsWith('/')) {
        resolved = pathApi.join(projectPath, resolved);
      }

      editor.openFile(resolved, 'terminal', { line, col });
    };
  }

  // Initialize history panel with terminal resize callback
  try {
    historyPanel.init('history-panel', 'history-content', () => {
      setTimeout(() => terminal.fitTerminal(), 50);
    });
  } catch (err) {
    console.error('Failed to initialize history panel:', err);
  }

  // Initialize plugins panel
  try { pluginsPanel.init(); } catch (err) { console.error('Failed to initialize plugins panel:', err); }

  // Initialize GitHub panel
  try { githubPanel.init(); } catch (err) { console.error('Failed to initialize GitHub panel:', err); }

  // Initialize saved prompts panel
  try { savedPromptsPanel.init(); } catch (err) { console.error('Failed to initialize saved prompts panel:', err); }

  // Initialize sidebar resize
  try {
    sidebarResize.init(() => {
      terminal.fitTerminal();
    });
  } catch (err) {
    console.error('Failed to initialize sidebar resize:', err);
  }

  setupResponsiveRightPanelCollapse();

  // Allow menu items (and other main-process actions) to toggle layout.
  try {
    ipcRenderer.on(IPC.TOGGLE_SIDEBAR, () => toggleSidebarSafe());
  } catch (err) {
    console.error('Failed to bind TOGGLE_SIDEBAR listener:', err);
  }

  // Setup state change listeners
  state.onProjectChange((projectPath, previousPath) => {
    if (projectPath) {
      fileTreeUI.loadFileTree(projectPath);

      // Add to workspace and update project list
      const projectName = projectPath.split('/').pop() || projectPath.split('\\').pop();
      projectListUI.addProject(projectPath, projectName);
      projectListUI.setActiveProject(projectPath);

      // Reload saved prompts if panel is visible
      if (savedPromptsPanel.isVisible()) {
        savedPromptsPanel.show();
      }
    } else {
      fileTreeUI.stopFileTreeWatch();
      fileTreeUI.clearFileTree();
    }
  });

  // Setup button handlers
  setupButtonHandlers();

  // Setup keyboard shortcuts
  setupKeyboardShortcuts();

  // Setup ResizeObserver on terminal container to handle all panel open/close/resize
  const terminalContainer = document.getElementById('terminal-container');
  if (terminalContainer) {
    // Live-fitting xterm during animated width transitions (panels) causes
    // constant reflow/rewrap, which looks like "flashing". We keep live fit
    // only for interactive sidebar dragging; everything else uses a debounced
    // (trailing) fit once the layout settles.
    const INTERACTIVE_THROTTLE_MS = 80;
    const INTERACTIVE_TRAILING_MS = 140;
    const NON_INTERACTIVE_DEBOUNCE_MS = 80;

    let resizeRafId = null;
    let interactiveTrailingTimer = null;
    let nonInteractiveFitTimer = null;
    let lastFitAt = 0;

    const runFit = () => {
      terminal.fitTerminal();
      lastFitAt = performance.now();
    };

    const scheduleNonInteractiveFit = () => {
      if (nonInteractiveFitTimer) clearTimeout(nonInteractiveFitTimer);
      nonInteractiveFitTimer = setTimeout(() => {
        nonInteractiveFitTimer = null;
        runFit();
      }, NON_INTERACTIVE_DEBOUNCE_MS);
    };

    const scheduleInteractiveTrailingFit = () => {
      if (interactiveTrailingTimer) clearTimeout(interactiveTrailingTimer);
      interactiveTrailingTimer = setTimeout(() => {
        interactiveTrailingTimer = null;
        runFit();
      }, INTERACTIVE_TRAILING_MS);
    };

    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;

        const isInteractiveSidebarDrag = document.body.classList.contains('sidebar-resizing');
        if (!isInteractiveSidebarDrag) {
          scheduleNonInteractiveFit();
          return;
        }

        const now = performance.now();
        if ((now - lastFitAt) >= INTERACTIVE_THROTTLE_MS) {
          runFit();
        }
        scheduleInteractiveTrailingFit();
      });
    });

    resizeObserver.observe(terminalContainer);
  }
}

/**
 * Setup button click handlers
 */
function setupButtonHandlers() {
  const showStartToast = (message, type = 'error') => {
    if (_startToast) _startToast.show(message, type);
  };

  // Create new project (header button)
  document.getElementById('btn-create-project').addEventListener('click', () => {
    state.createNewProject();
  });

  // Start AI Tool (Claude Code / Codex CLI / etc.)
  const startAiBtn = document.getElementById('btn-start-ai');
  startAiBtn.addEventListener('click', async () => {
    if (startAiBtn.dataset.busy === '1') return;

    const projectPath = state.getProjectPath();
    if (!projectPath) return;

    startAiBtn.dataset.busy = '1';
    startAiBtn.disabled = true;

    try {
      const currentAiTool = aiToolSelector.getCurrentTool();
      const aiToolId = currentAiTool ? currentAiTool.id : null;
      const newTerminalId = await terminal.restartTerminal(projectPath, { aiTool: aiToolId });
      if (!newTerminalId) {
        throw new Error('Terminal could not be created');
      }

      // Ensure the new terminal is focused
      terminal.setActiveTerminal(newTerminalId);

      // Send start command for the selected AI tool
      const startCommand = aiToolSelector.getStartCommand();
      setTimeout(() => {
        terminal.sendCommand(startCommand, newTerminalId);
      }, 150);
    } catch (err) {
      console.error('Failed to start AI tool terminal:', err);
      showStartToast(err?.message || 'Failed to start AI tool terminal', 'error');
    } finally {
      startAiBtn.dataset.busy = '0';
      if (state.getProjectPath()) {
        startAiBtn.disabled = false;
      }
    }
  });

  // Refresh file tree
  document.getElementById('btn-refresh-tree').addEventListener('click', () => {
    fileTreeUI.refreshFileTree();
  });

  // Close history panel
  document.getElementById('history-close').addEventListener('click', () => {
    historyPanel.toggleHistoryPanel();
  });

  // Add project to workspace
  document.getElementById('btn-add-project').addEventListener('click', () => {
    state.selectProjectFolder();
  });

}

/**
 * Setup keyboard shortcuts
 */
function setupKeyboardShortcuts() {
  const toggleExclusivePanel = (targetPanel, otherPanels) => {
    if (targetPanel.isVisible()) {
      targetPanel.hide();
      return;
    }
    otherPanels.forEach((panel) => panel.hide());
    targetPanel.show();
  };

  document.addEventListener('keydown', (e) => {
    const modKey = e.ctrlKey || e.metaKey; // Support both Ctrl (Windows/Linux) and Cmd (macOS)
    const key = e.key.toLowerCase(); // Normalize key to lowercase

    // Ctrl/Cmd+Shift+H - Toggle history panel
    if (modKey && e.shiftKey && key === 'h') {
      e.preventDefault();
      historyPanel.toggleHistoryPanel();
    }
    // Ctrl/Cmd+Shift+P - Toggle plugins panel
    if (modKey && e.shiftKey && key === 'p') {
      e.preventDefault();
      toggleExclusivePanel(pluginsPanel, [githubPanel, savedPromptsPanel]);
    }
    // Ctrl/Cmd+Shift+G - Toggle GitHub panel
    if (modKey && e.shiftKey && key === 'g') {
      e.preventDefault();
      toggleExclusivePanel(githubPanel, [pluginsPanel, savedPromptsPanel]);
    }
    // Ctrl/Cmd+B - Toggle sidebar
    if (modKey && !e.shiftKey && key === 'b') {
      e.preventDefault();
      toggleSidebarSafe();
    }
    // Ctrl/Cmd+Shift+[ - Previous project
    if (modKey && e.shiftKey && e.key === '[') {
      e.preventDefault();
      projectListUI.selectPrevProject();
    }
    // Ctrl/Cmd+Shift+] - Next project
    if (modKey && e.shiftKey && e.key === ']') {
      e.preventDefault();
      projectListUI.selectNextProject();
    }
    // Ctrl/Cmd+E - Focus project list
    if (modKey && !e.shiftKey && key === 'e') {
      e.preventDefault();
      fileTreeUI.blur();
      projectListUI.focus();
    }
    // Ctrl/Cmd+Shift+E - Focus file tree
    if (modKey && e.shiftKey && key === 'e') {
      e.preventDefault();
      projectListUI.blur();
      fileTreeUI.focus();
    }
    // Ctrl/Cmd+Shift+S - Toggle saved prompts panel
    if (modKey && e.shiftKey && key === 's') {
      e.preventDefault();
      toggleExclusivePanel(savedPromptsPanel, [pluginsPanel, githubPanel]);
    }
  });
}

/**
 * Start application when DOM is ready
 */
window.addEventListener('load', () => {
  init();

  // Give a moment for terminal to fully render, then start PTY
  setTimeout(() => {
    terminal.startTerminal();
  }, 100);
});
