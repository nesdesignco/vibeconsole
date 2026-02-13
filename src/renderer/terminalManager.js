/**
 * Terminal Manager Module
 * Manages multiple terminal instances in the renderer
 */

const { ipcRenderer, clipboard } = require('./electronBridge');
const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');
const { IPC } = require('../shared/ipcChannels');
const { shellQuote } = require('./shellEscape');

// Terminal theme (VS Code dark)
const terminalTheme = {
  background: '#12121a',
  foreground: '#d4d4e4',
  cursor: '#a78bfa',
  cursorAccent: '#12121a',
  selectionBackground: 'rgba(167, 139, 250, 0.25)',
  black: '#16161e',
  red: '#f47067',
  green: '#57cc99',
  yellow: '#e0a458',
  blue: '#78a5d4',
  magenta: '#c4b5fd',
  cyan: '#56d4dd',
  white: '#e4e4ed',
  brightBlack: '#6b6880',
  brightRed: '#ff8080',
  brightGreen: '#7ee8b0',
  brightYellow: '#ffd580',
  brightBlue: '#a0c4f0',
  brightMagenta: '#ddd6fe',
  brightCyan: '#80e8f0',
  brightWhite: '#f0f0f8'
};

// Session storage key
const SESSION_STORAGE_KEY = 'vibeconsole-terminal-sessions';
const GLOBAL_PROJECT_KEY = '__global__';
const AI_TOOL_COMMAND_MAP = {
  claude: 'claude',
  codex: 'codex'
};

class TerminalManager {
  constructor() {
    this.terminals = new Map(); // Map<id, {terminal, fitAddon, element, state}>
    this._inputLineBuffers = new Map(); // Map<terminalId, currentInputLine>
    this._savedScrollState = new Map(); // Map<terminalId, {viewportY, wasAtBottom}>
    this._forceBottomOnProjectSwitch = false; // Force active terminal to bottom after project switches
    this.activeTerminalId = null;
    this.viewMode = 'tabs'; // 'tabs' or 'grid'
    this.gridLayout = '2x2';
    this.maxTerminals = 9;
    this.terminalCounter = 0;
    this.onStateChange = null;
    this.currentProjectPath = null; // Current active project (null = global)
    this._setupIPC();
  }

  _isAtOrNearBottom(terminal, thresholdLines = 1) {
    if (!terminal) return true;
    const buf = terminal.buffer?.active;
    if (!buf) return true;
    // xterm: at bottom when viewportY === baseY. Using a small threshold avoids
    // getting "stuck" 1-2 lines above bottom after resizes/reflows.
    return (buf.baseY - buf.viewportY) <= thresholdLines;
  }

  _syncScrollDownButton(instance) {
    if (!instance || !instance.scrollBtn || !instance.terminal) return;
    const isAtBottom = this._isAtOrNearBottom(instance.terminal, 1);
    instance.scrollBtn.classList.toggle('visible', !isAtBottom);
  }

  _scheduleDeferredScrollRestore(terminalId, maxAttempts = 10) {
    let attempts = 0;
    const tick = () => {
      const instance = this.terminals.get(terminalId);
      if (!instance || !instance.opened || !this._isInDOM(instance)) return;

      if (this._restoreScrollState(terminalId)) {
        this._syncScrollDownButton(instance);
        return;
      }

      attempts++;
      if (attempts >= maxAttempts || !this._savedScrollState.has(terminalId)) return;
      setTimeout(tick, 60);
    };

    setTimeout(tick, 60);
  }

  /**
   * Set current project context
   * @param {string|null} projectPath - Project path or null for global
   */
  setCurrentProject(projectPath) {
    // Save current project session before switching
    if (this.currentProjectPath !== projectPath) {
      this.saveProjectSession(this.currentProjectPath);
      this._forceBottomOnProjectSwitch = true;
    }

    this.currentProjectPath = projectPath;

    // Restore session for new project
    this.restoreProjectSession(projectPath);

    this._notifyStateChange();
  }

  /**
   * Get current project path
   */
  getCurrentProject() {
    return this.currentProjectPath;
  }

  /**
   * Get terminals for a specific project
   * @param {string|null} projectPath - Project path or null for global
   */
  getTerminalsByProject(projectPath) {
    return Array.from(this.terminals.values())
      .filter(t => t.state.projectPath === projectPath)
      .map(t => ({ ...t.state }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Save project session to localStorage
   * @param {string|null} projectPath - Project path or null for global
   */
  saveProjectSession(projectPath) {
    const sessionKey = projectPath || GLOBAL_PROJECT_KEY;
    const projectTerminals = this.getTerminalsByProject(projectPath);

    if (projectTerminals.length === 0) {
      return; // Nothing to save
    }

    const sessionData = {
      activeTerminalId: this.activeTerminalId,
      viewMode: this.viewMode,
      gridLayout: this.gridLayout,
      terminalNames: {} // Map of terminalId -> customName
    };

    // Save custom names
    projectTerminals.forEach(t => {
      if (t.customName) {
        sessionData.terminalNames[t.id] = t.customName;
      }
    });

    try {
      const allSessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
      allSessions[sessionKey] = sessionData;
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(allSessions));
    } catch (err) {
      console.error('Failed to save terminal session:', err);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  /**
   * Restore project session from localStorage
   * @param {string|null} projectPath - Project path or null for global
   */
  restoreProjectSession(projectPath) {
    const sessionKey = projectPath || GLOBAL_PROJECT_KEY;

    try {
      const allSessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
      const sessionData = allSessions[sessionKey];

      if (sessionData) {
        // Restore view settings
        if (sessionData.viewMode) {
          this.viewMode = sessionData.viewMode;
        }
        if (sessionData.gridLayout) {
          this.gridLayout = sessionData.gridLayout;
        }

        // Restore custom names for existing terminals
        const projectTerminals = this.getTerminalsByProject(projectPath);
        projectTerminals.forEach(t => {
          if (sessionData.terminalNames && sessionData.terminalNames[t.id]) {
            const instance = this.terminals.get(t.id);
            if (instance) {
              instance.state.customName = sessionData.terminalNames[t.id];
              instance.state.name = sessionData.terminalNames[t.id];
            }
          }
        });

        // Restore active terminal if it belongs to current project
        if (sessionData.activeTerminalId) {
          const terminal = this.terminals.get(sessionData.activeTerminalId);
          if (terminal && terminal.state.projectPath === projectPath) {
            this.setActiveTerminal(sessionData.activeTerminalId);
            return;
          }
        }
      }

      // If no valid active terminal found, select first terminal of current project
      const projectTerminals = this.getTerminalsByProject(projectPath);
      if (projectTerminals.length > 0) {
        this.setActiveTerminal(projectTerminals[0].id);
      } else {
        this.activeTerminalId = null;
      }
    } catch (err) {
      console.error('Failed to restore terminal session:', err);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  /**
   * Create a new terminal
   * @param {Object} [options] - Options for terminal creation
   * @param {string|null} [options.cwd] - Working directory
   * @param {string|null} [options.projectPath] - Associated project path (undefined = use current)
   * @param {string} [options.name] - Custom terminal name
   * @param {string|null} [options.shell] - Shell path to use
   * @param {string|null} [options.aiTool] - AI tool id associated with this terminal
   */
  async createTerminal(options = {}) {
    if (this.terminals.size >= this.maxTerminals) {
      console.error('Maximum terminal limit reached');
      return null;
    }

    // Use provided projectPath or current project
    const projectPath = options.projectPath !== undefined
      ? options.projectPath
      : this.currentProjectPath;

    // Working directory: use provided cwd, or project path, or home directory
    const workingDir = options.cwd || projectPath || null;

    const response = await ipcRenderer.invoke(IPC.TERMINAL_CREATE, {
      cwd: workingDir,
      projectPath,
      shell: options.shell || null
    });

    if (response.success) {
      this._initializeTerminal(response.terminalId, {
        ...options,
        projectPath,
        cwd: workingDir
      });
      return response.terminalId;
    } else {
      throw new Error(response.error);
    }
  }

  /**
   * Get available shells from main process
   * @returns {Promise<Array<{id: string, name: string, path: string}>>}
   */
  async getAvailableShells() {
    const response = await ipcRenderer.invoke(IPC.GET_AVAILABLE_SHELLS);
    if (response.success) {
      return response.shells;
    } else {
      throw new Error(response.error || 'Failed to get available shells');
    }
  }

  /**
   * Initialize xterm.js instance for a terminal
   */
  _initializeTerminal(terminalId, options) {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Geist Mono", "SF Mono", Consolas, monospace',
      theme: terminalTheme,
      allowTransparency: false,
      scrollback: 10000
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Create container element
    const element = document.createElement('div');
    element.id = `terminal-${terminalId}`;
    element.className = 'terminal-instance';
    element.style.height = '100%';
    element.style.width = '100%';

    // Scroll-to-bottom button
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'terminal-scroll-down';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    element.appendChild(scrollBtn);

    const syncScrollBtn = () => {
      const isAtBottom = this._isAtOrNearBottom(terminal, 1);
      scrollBtn.classList.toggle('visible', !isAtBottom);
    };

    let syncRafId = null;
    const scheduleSyncScrollBtn = () => {
      if (syncRafId) return;
      syncRafId = requestAnimationFrame(() => {
        syncRafId = null;
        syncScrollBtn();
      });
    };

    scrollBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      terminal.scrollToBottom();
      terminal.focus();
      scheduleSyncScrollBtn();
    });

    // Track scroll position to show/hide scroll button
    terminal.onScroll(scheduleSyncScrollBtn);
    terminal.onRender(scheduleSyncScrollBtn);
    element.addEventListener('wheel', scheduleSyncScrollBtn, { passive: true });
    // Some programmatic scroll changes (fit/restore) may not emit onScroll reliably.
    scheduleSyncScrollBtn();

    // Focus terminal on click anywhere in the container
    element.addEventListener('click', () => {
      terminal.focus();
    });

    // Drag & drop: paste file paths into terminal
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.add('drag-over');
    });

    element.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');

      // 1. Internal drag from file tree (custom MIME)
      const vibeconsoleFile = e.dataTransfer.getData('application/x-vibeconsole-file');
      if (vibeconsoleFile) {
        terminal.paste(shellQuote(vibeconsoleFile) + ' ');
        return;
      }

      // 2. OS file drag
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const paths = Array.from(files).map(f => shellQuote(f.path));
        terminal.paste(paths.join(' ') + ' ');
        return;
      }

      // 3. Fallback: plain text
      const text = e.dataTransfer.getData('text/plain');
      if (text) {
        terminal.paste(text + ' ');
      }
    });

    const isCodeMatch = (event, code) => event.code === code || event.key.toLowerCase() === code.slice(-1).toLowerCase();
    const normalizePasteText = (text) => (text || '').replace(/\r\n/g, '\n');
    const pasteClipboardText = (text) => {
      const normalizedText = normalizePasteText(text);
      if (!normalizedText) return false;
      terminal.paste(normalizedText);
      return true;
    };
    const pasteFromSystemClipboard = () => pasteClipboardText(clipboard.readText());

    const state = {
      id: terminalId,
      name: options.name || `Terminal ${++this.terminalCounter}`,
      customName: null,
      isActive: false,
      createdAt: Date.now(),
      projectPath: options.projectPath !== undefined ? options.projectPath : this.currentProjectPath,
      aiTool: options.aiTool || null
    };

    this.terminals.set(terminalId, {
      terminal,
      fitAddon,
      element,
      scrollBtn,
      syncScrollBtn,
      scheduleSyncScrollBtn,
      state,
      lastSentCols: null,
      lastSentRows: null
    });

    // Allow app-level shortcuts to pass through when terminal has focus
    terminal.attachCustomKeyEventHandler((event) => {
      const modKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (event.type === 'keydown') {
        const isCopyMeta = event.metaKey && isCodeMatch(event, 'KeyC');
        const isCopyCtrlShift = event.ctrlKey && event.shiftKey && isCodeMatch(event, 'KeyC');
        const isCopyCtrl = event.ctrlKey && !event.shiftKey && !event.altKey && isCodeMatch(event, 'KeyC');
        const isCopyShortcut = isCopyMeta || isCopyCtrlShift || isCopyCtrl;

        if (isCopyShortcut && terminal.hasSelection()) {
          clipboard.writeText(terminal.getSelection());
          terminal.clearSelection();
          return false;
        }
        // Let Ctrl+C continue to terminal when nothing is selected (SIGINT, etc.).
        if (isCopyCtrl) {
          return true;
        }
        // Swallow copy shortcuts with no selection to avoid accidental control chars.
        if (isCopyMeta || isCopyCtrlShift) {
          return false;
        }

        // Paste: Ctrl/Cmd+V, Ctrl+Shift+V, Shift+Insert
        const isPasteMeta = event.metaKey && isCodeMatch(event, 'KeyV');
        const isPasteCtrl = event.ctrlKey && !event.altKey && isCodeMatch(event, 'KeyV');
        const isPasteShiftInsert = !modKey && event.shiftKey && (event.code === 'Insert' || event.key === 'Insert');
        if (isPasteMeta || isPasteCtrl) {
          // Let the paste event flow run for Cmd/Ctrl+V to avoid duplicate inserts.
          return true;
        }
        if (isPasteShiftInsert) {
          // Shift+Insert may not trigger native paste reliably across platforms.
          if (pasteFromSystemClipboard()) {
            event.preventDefault();
            return false;
          }
          return true;
        }
      }

      // Ctrl/Cmd + Shift combinations → pass to app
      if (modKey && event.shiftKey) {
        return false;
      }
      // Ctrl/Cmd + 1-9 → pass to app
      if (modKey && event.key >= '1' && event.key <= '9') {
        return false;
      }
      // Ctrl/Cmd + K (Start Claude) → pass to app
      if (modKey && key === 'k') {
        return false;
      }
      // Ctrl/Cmd + I (/init) → pass to app
      if (modKey && key === 'i') {
        return false;
      }
      // Ctrl/Cmd + H (history) → pass to app
      if (modKey && key === 'h') {
        return false;
      }
      // Ctrl/Cmd + B (sidebar toggle) → pass to app
      if (modKey && key === 'b') {
        return false;
      }
      // Ctrl/Cmd + E (project/file focus) → pass to app
      if (modKey && key === 'e') {
        return false;
      }
      // Ctrl/Cmd + T (tasks panel) → pass to app (without shift)
      if (modKey && !event.shiftKey && key === 't') {
        return false;
      }
      // Ctrl/Cmd + [ or ] (project navigation) → pass to app
      if (modKey && (event.key === '[' || event.key === ']')) {
        return false;
      }
      // Ctrl/Cmd + Tab → pass to app
      if (modKey && event.key === 'Tab') {
        return false;
      }
      // Let terminal handle everything else
      return true;
    });

    // Right-click paste
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      pasteFromSystemClipboard();
    });

    // Handle input
    terminal.onData((data) => {
      this._trackInputForAiTool(terminalId, data);
      ipcRenderer.send(IPC.TERMINAL_INPUT_ID, { terminalId, data });
    });

    // If first terminal or no active terminal, make it active
    if (this.terminals.size === 1 || !this.activeTerminalId) {
      this.setActiveTerminal(terminalId);
    }

    this._renumberTerminals(state.projectPath);
    this._notifyStateChange();
    return terminalId;
  }

  /**
   * Mount terminal in a container
   */
  mountTerminal(terminalId, container) {
    const instance = this.terminals.get(terminalId);
    if (instance && container) {
      // Clear container first
      container.innerHTML = '';

      // Ensure element has proper sizing
      instance.element.style.height = '100%';
      instance.element.style.width = '100%';

      container.appendChild(instance.element);

      // Open terminal if not already opened
      if (!instance.opened) {
        instance.terminal.open(instance.element);
        instance.opened = true;
      }

      // Fit after layout is complete: rAF ensures DOM is painted, then setTimeout runs after
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!this._isInDOM(instance)) return;
          instance.fitAddon.fit();
          this._sendResize(terminalId);
          // On project switch, keep active terminal pinned to bottom to avoid
          // stale viewport restores that look like a jump to upper lines.
          const shouldForceBottom = this._forceBottomOnProjectSwitch && terminalId === this.activeTerminalId;
          if (shouldForceBottom) {
            this._savedScrollState.delete(terminalId);
            instance.terminal.scrollToBottom();
            // When terminals are re-parented (project switches / view changes), some
            // environments can end up with the DOM scrollbar thumb at the top while
            // xterm's internal buffer is at the bottom. Force-sync the viewport to
            // avoid "snap to top" on the next wheel/scroll interaction.
            this._forceViewportScrollToBottom(instance);
            this._forceBottomOnProjectSwitch = false;
          } else if (!this._restoreScrollState(terminalId)) {
            // Restore saved scroll position, or scroll to bottom for new terminals
            instance.terminal.scrollToBottom();
            this._forceViewportScrollToBottom(instance);
            // If we had a saved scroll position but the buffer isn't populated yet,
            // retry briefly to avoid snapping to the top.
            if (this._savedScrollState.has(terminalId)) {
              this._scheduleDeferredScrollRestore(terminalId);
            }
          }
          this._syncScrollDownButton(instance);
          // Focus if this is the active terminal
          if (this.activeTerminalId === terminalId) {
            instance.terminal.focus();
          }
        }, 50);
      });
    }
  }

  /**
   * Set active terminal
   */
  setActiveTerminal(terminalId) {
    if (this.activeTerminalId === terminalId) {
      // Already active, just ensure focus
      const current = this.terminals.get(terminalId);
      if (current) {
        current.terminal.focus();
      }
      return;
    }

    // Update previous active
    if (this.activeTerminalId) {
      const prev = this.terminals.get(this.activeTerminalId);
      if (prev) prev.state.isActive = false;
    }

    // Set new active
    this.activeTerminalId = terminalId;
    const current = this.terminals.get(terminalId);
    if (current) {
      current.state.isActive = true;
      current.terminal.focus();
    }

    this._notifyStateChange();
  }

  /**
   * Rename terminal
   */
  renameTerminal(terminalId, newName) {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      instance.state.customName = newName;
      instance.state.name = newName;
      this._notifyStateChange();
    }
  }

  /**
   * Associate an AI tool with a terminal.
   * @param {string} terminalId - Terminal ID
   * @param {'claude'|'codex'|null} aiTool - Tool identifier
   */
  setTerminalAiTool(terminalId, aiTool) {
    const instance = this.terminals.get(terminalId);
    if (!instance) return;

    if (instance.state.aiTool === aiTool) return;

    instance.state.aiTool = aiTool;
    this._notifyStateChange();
  }

  /**
   * Close terminal
   */
  closeTerminal(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      this._inputLineBuffers.delete(terminalId);
      this._savedScrollState.delete(terminalId);
      instance.terminal.dispose();
      instance.element.remove();
      this.terminals.delete(terminalId);
      ipcRenderer.send(IPC.TERMINAL_DESTROY, terminalId);

      if (this.activeTerminalId === terminalId) {
        // Select from same project's terminals, not all terminals
        const projectTerminals = this.getTerminalsByProject(instance.state.projectPath);
        if (projectTerminals.length > 0) {
          this.activeTerminalId = projectTerminals[projectTerminals.length - 1].id;
          this.setActiveTerminal(this.activeTerminalId);
        } else {
          this.activeTerminalId = null;
        }
      }

      this._renumberTerminals(instance.state.projectPath);
      this._notifyStateChange();
    }
  }

  /**
   * Set view mode
   */
  setViewMode(mode) {
    this.viewMode = mode;
    this._notifyStateChange();
  }

  /**
   * Set grid layout
   */
  setGridLayout(layout) {
    this.gridLayout = layout;
    this._notifyStateChange();
  }

  /**
   * Get all terminal states (filtered by current project)
   * @param {boolean} allProjects - If true, return all terminals regardless of project
   */
  getTerminalStates(allProjects = false) {
    let terminals = Array.from(this.terminals.values());

    if (!allProjects) {
      // Filter by current project
      terminals = terminals.filter(t => t.state.projectPath === this.currentProjectPath);
    }

    return terminals
      .map(t => ({ ...t.state }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get terminal instance
   */
  getTerminal(terminalId) {
    return this.terminals.get(terminalId);
  }

  /**
   * Get active terminal state.
   * @returns {Object|null}
   */
  getActiveTerminalState() {
    if (!this.activeTerminalId) return null;
    const instance = this.terminals.get(this.activeTerminalId);
    if (!instance) return null;
    return { ...instance.state };
  }

  /**
   * Fit all terminals (preserves scroll position)
   */
  fitAll() {
    for (const [id, instance] of this.terminals) {
      if (instance.opened && this._isInDOM(instance)) {
        try {
          const buf = instance.terminal.buffer.active;
          const viewportYBefore = buf.viewportY;
          const wasAtBottom = this._isAtOrNearBottom(instance.terminal, 1);
          instance.fitAddon.fit();
          this._sendResize(id);
          if (wasAtBottom) {
            instance.terminal.scrollToBottom();
            this._forceViewportScrollToBottom(instance);
          } else {
            const newBaseY = instance.terminal.buffer.active.baseY;
            instance.terminal.scrollToLine(Math.min(viewportYBefore, newBaseY));
          }
          this._syncScrollDownButton(instance);
        } catch (err) {
          console.error(`Failed to fit terminal ${id}:`, err);
        }
      }
    }
  }

  /**
   * Fit specific terminal (preserves scroll position)
   */
  fitTerminal(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (instance && instance.opened && this._isInDOM(instance)) {
      const buf = instance.terminal.buffer.active;
      const viewportYBefore = buf.viewportY;
      const wasAtBottom = this._isAtOrNearBottom(instance.terminal, 1);
      instance.fitAddon.fit();
      this._sendResize(terminalId);
      if (wasAtBottom) {
        instance.terminal.scrollToBottom();
        this._forceViewportScrollToBottom(instance);
      } else {
        const newBaseY = instance.terminal.buffer.active.baseY;
        instance.terminal.scrollToLine(Math.min(viewportYBefore, newBaseY));
      }
      this._syncScrollDownButton(instance);
    }
  }

  /**
   * Write to active terminal
   */
  writeToActive(data) {
    if (this.activeTerminalId) {
      const instance = this.terminals.get(this.activeTerminalId);
      if (instance) {
        const wasAtBottom = this._isAtOrNearBottom(instance.terminal, 1);
        instance.terminal.write(data, () => {
          if (wasAtBottom) instance.terminal.scrollToBottom();
          if (typeof instance.scheduleSyncScrollBtn === 'function') {
            instance.scheduleSyncScrollBtn();
          } else {
            this._syncScrollDownButton(instance);
          }
        });
      }
    }
  }

  /**
   * Send command to active terminal or specific terminal
   * @param {string} command - Command to send
   * @param {string} [terminalId] - Optional specific terminal ID
   */
  sendCommand(command, terminalId = null) {
    const targetId = terminalId || this.activeTerminalId;
    
    if (targetId) {
      this._detectAiToolFromCommand(targetId, command);
      ipcRenderer.send(IPC.TERMINAL_INPUT_ID, {
        terminalId: targetId,
        data: command + '\r'
      });
    }
  }

  /**
   * Save scroll position for a terminal (before unmount)
   */
  _saveScrollState(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (!instance || !instance.opened) return;
    const buf = instance.terminal.buffer.active;
    // Use a small threshold: after fit/reflow xterm can land 1-2 lines above baseY.
    const wasAtBottom = this._isAtOrNearBottom(instance.terminal, 1);
    this._savedScrollState.set(terminalId, {
      viewportY: buf.viewportY,
      wasAtBottom
    });
  }

  /**
   * Restore scroll position for a terminal (after remount)
   * Returns true if state was restored, false otherwise
   */
  _restoreScrollState(terminalId) {
    const saved = this._savedScrollState.get(terminalId);
    if (!saved) return false;

    const instance = this.terminals.get(terminalId);
    if (!instance || !instance.opened) return false;

    if (saved.wasAtBottom) {
      instance.terminal.scrollToBottom();
      this._forceViewportScrollToBottom(instance);
      this._savedScrollState.delete(terminalId);
    } else {
      const newBaseY = instance.terminal.buffer.active.baseY;
      // Buffer not populated yet (baseY=0) but we have a meaningful saved viewport.
      // Defer restore to avoid snapping to the top.
      if (newBaseY === 0 && saved.viewportY > 0) return false;
      const clampedY = Math.min(saved.viewportY, newBaseY);
      instance.terminal.scrollToLine(clampedY);
      this._savedScrollState.delete(terminalId);
    }
    return true;
  }

  // Private methods
  _isInDOM(instance) {
    return instance.element && instance.element.isConnected;
  }

  _forceViewportScrollToBottom(instance) {
    try {
      const root = instance?.element;
      if (!root || typeof root.querySelector !== 'function') return false;
      const viewport = root.querySelector('.xterm-viewport');
      if (!viewport) return false;
      viewport.scrollTop = viewport.scrollHeight;
      return true;
    } catch {
      return false;
    }
  }

  _sendResize(terminalId) {
    const instance = this.terminals.get(terminalId);
    if (instance) {
      const cols = instance.terminal.cols;
      const rows = instance.terminal.rows;
      if (cols <= 0 || rows <= 0) return;
      if (instance.lastSentCols === cols && instance.lastSentRows === rows) return;

      instance.lastSentCols = cols;
      instance.lastSentRows = rows;

      ipcRenderer.send(IPC.TERMINAL_RESIZE_ID, {
        terminalId,
        cols,
        rows
      });
    }
  }

  _trackInputForAiTool(terminalId, data) {
    if (!data) return;

    const sanitized = this._stripTerminalControlSequences(data);
    let buffer = this._inputLineBuffers.get(terminalId) || '';

    for (const char of sanitized) {
      if (char === '\r') {
        this._detectAiToolFromCommand(terminalId, buffer);
        buffer = '';
        continue;
      }

      if (char === '\n') continue;
      if (char === '\u0003' || char === '\u0015') { // Ctrl+C/Ctrl+U clears the typed line intent.
        buffer = '';
        continue;
      }
      if (char === '\u0008' || char === '\u007f') {
        buffer = buffer.slice(0, -1);
        continue;
      }

      if (this._isTrackableInputChar(char)) {
        buffer += char;
        if (buffer.length > 4096) {
          buffer = buffer.slice(-4096);
        }
      }
    }

    this._inputLineBuffers.set(terminalId, buffer);
  }

  _detectAiToolFromCommand(terminalId, line) {
    if (!line || typeof line !== 'string') return;

    const trimmed = line.trim();
    if (!trimmed) return;

    const [firstToken] = trimmed.split(/\s+/);
    const aiTool = AI_TOOL_COMMAND_MAP[firstToken];
    if (aiTool) {
      this.setTerminalAiTool(terminalId, aiTool);
    }
  }

  _isTrackableInputChar(char) {
    const code = char.codePointAt(0);
    if (code === undefined) return false;
    return code >= 0x20 && code !== 0x7f;
  }

  _stripTerminalControlSequences(data) {
    let result = '';
    let index = 0;

    while (index < data.length) {
      const char = data[index];

      if (char !== '\u001b') {
        result += char;
        index++;
        continue;
      }

      const next = data[index + 1];
      if (!next) {
        index++;
        continue;
      }

      // CSI: ESC [ ... final-byte(0x40-0x7E)
      if (next === '[') {
        index += 2;
        while (index < data.length) {
          const code = data.charCodeAt(index);
          index++;
          if (code >= 0x40 && code <= 0x7e) break;
        }
        continue;
      }

      // OSC: ESC ] ... BEL or ESC \
      if (next === ']') {
        index += 2;
        while (index < data.length) {
          const current = data[index];
          if (current === '\u0007') {
            index++;
            break;
          }
          if (current === '\u001b' && data[index + 1] === '\\') {
            index += 2;
            break;
          }
          index++;
        }
        continue;
      }

      // SS3: ESC O <char>
      if (next === 'O') {
        index += 3;
        continue;
      }

      // Generic ESC sequence: consume ESC + next char
      index += 2;
    }

    return result;
  }

  _notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange({
        terminals: this.getTerminalStates(),
        activeTerminalId: this.activeTerminalId,
        viewMode: this.viewMode,
        gridLayout: this.gridLayout,
        currentProjectPath: this.currentProjectPath
      });
    }
  }

  /**
   * Check if there are terminals for the current project
   */
  hasTerminalsForCurrentProject() {
    return this.getTerminalStates().length > 0;
  }

  /**
   * Clear session storage for a project (used when app restarts)
   * @param {string|null} projectPath - Project path or null for global
   */
  clearProjectSession(projectPath) {
    const sessionKey = projectPath || GLOBAL_PROJECT_KEY;
    try {
      const allSessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
      delete allSessions[sessionKey];
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(allSessions));
    } catch (err) {
      console.error('Failed to clear terminal session:', err);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  _setupIPC() {
    // Receive output from specific terminal
    ipcRenderer.on(IPC.TERMINAL_OUTPUT_ID, (event, { terminalId, data }) => {
      const instance = this.terminals.get(terminalId);
      if (instance) {
        const wasAtBottom = this._isAtOrNearBottom(instance.terminal, 1);
        instance.terminal.write(data, () => {
          if (wasAtBottom) instance.terminal.scrollToBottom();
          if (typeof instance.scheduleSyncScrollBtn === 'function') {
            instance.scheduleSyncScrollBtn();
          } else {
            this._syncScrollDownButton(instance);
          }
        });
      }
    });

    // Handle terminal destroyed from main process
    ipcRenderer.on(IPC.TERMINAL_DESTROYED, (event, { terminalId }) => {
      if (this.terminals.has(terminalId)) {
        this.closeTerminal(terminalId);
      }
    });
  }

  /**
   * Renumber terminals for a project to ensure sequential naming (Terminal 1, Terminal 2, ...)
   * Only affects terminals without custom names. Only notifies if names actually changed.
   */
  _renumberTerminals(projectPath) {
    const terminals = this.getTerminalsByProject(projectPath);
    let changed = false;

    terminals.forEach((tState, index) => {
      const instance = this.terminals.get(tState.id);
      if (instance && !instance.state.customName) {
        const newName = `Terminal ${index + 1}`;
        if (instance.state.name !== newName) {
          instance.state.name = newName;
          changed = true;
        }
      }
    });

    // Only notify if names actually changed
    if (changed) {
      this._notifyStateChange();
    }
  }
}

module.exports = { TerminalManager };
